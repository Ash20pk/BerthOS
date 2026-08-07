// agent-init — Phase 3's kernel enforcement layer.
//
// Sits between entrypoint.sh and the resident app's actual command (the SDK
// runtime, check-exports.js, npm test, ...). Reads the capability policy
// generated from berth.yml (see @berth/sdk's generate-capability-policy.ts),
// applies a Landlock ruleset restricting write-ish filesystem access to only
// the declared paths, then exec()s into the original command. Landlock
// restrictions are inherited across execve() and can never be lifted, so
// everything downstream — the runtime and any process it spawns — is
// permanently bound by this policy, enforced by the kernel, not by an SDK
// the app's own code runs alongside.
use std::env;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use caps::{CapSet, Capability};
use landlock::{
    AccessFs, AccessNet, Access, BitFlags, NetPort, PathBeneath, PathFd, Ruleset, RulesetAttr,
    RulesetCreatedAttr, RulesetStatus, ABI,
};
use serde::Deserialize;

mod seccomp;

#[derive(Deserialize)]
struct CapabilityPolicy {
    #[serde(rename = "appName")]
    app_name: String,
    #[serde(rename = "declaredCapabilities")]
    declared_capabilities: Vec<String>,
    #[serde(rename = "writePaths")]
    write_paths: Vec<String>,
    // Both opt-in: absent/empty means "don't touch this access type at all,"
    // preserved via #[serde(default)] so policy files written before this
    // change (no readPaths/networkPorts fields) still deserialize cleanly.
    #[serde(rename = "readPaths", default)]
    read_paths: Vec<String>,
    #[serde(rename = "networkPorts", default)]
    network_ports: Vec<u16>,
    // Deny-by-default: network access is restricted to `network_ports` unless
    // this is set, which is the explicit, audited escape hatch for an app
    // that declared `network:connect:*` (e.g. browser-native, which needs to
    // reach arbitrary hosts). See generate-capability-policy.ts.
    #[serde(rename = "networkUnrestricted", default)]
    network_unrestricted: bool,
    // Declared network:peer:<name> globs (see docs/mesh-reference.md). Not
    // acted on here — mesh-daemon (which runs before this process, outside
    // any Landlock ruleset) is what actually decides which peers get wired
    // into wg0, via mesh-coordinator's mutual-match introduction. This field
    // exists purely so it's captured in the audit line below.
    #[serde(rename = "meshPeers", default)]
    mesh_peers: Vec<String>,
    // Ports this app is allowed to bind()/listen() on — e.g. @berth/sdk's
    // HTTP RPC bridge (see docs/agents-reference.md's "Reaching a Computer
    // from outside Node/Docker" section). Separate from network_ports:
    // AccessNet::from_all handles (denies-by-default) BindTcp too the
    // moment network access is restricted at all, not just ConnectTcp, and
    // no capability namespace/action declares "this app needs to listen" —
    // it's an orchestration-level fact (see generate-capability-policy.ts's
    // computeBindPorts()), not something berth.yml's author writes.
    #[serde(rename = "bindPorts", default)]
    bind_ports: Vec<u16>,
}

/// Set by entrypoint.sh before anything else in the container starts —
/// shared by every daemon and app process in this boot (context-bus,
/// semantic-fs, mesh, every per-app agent-init). Threading it into every
/// audit line below is what makes it possible to correlate a single
/// production incident across process boundaries by grepping for one
/// string, instead of matching log timestamps by hand across three
/// runtimes. Falls back to "unknown" rather than failing — a missing boot
/// id (e.g. this binary run standalone, outside entrypoint.sh, as some
/// tests do) should never be why the resident app fails to boot.
fn boot_id() -> String {
    env::var("BERTH_BOOT_ID").unwrap_or_else(|_| "unknown".to_string())
}

/// One structured JSON line per boot — a real, greppable audit record of
/// what was granted, since Landlock itself has no deny-notification hook to
/// log individual denials from (see docs/capability-tokens-reference.md).
fn log_audit_event(policy: &CapabilityPolicy, ruleset_status: &str) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    eprintln!(
        "[agent-init] {{\"event\":\"capability_policy_applied\",\"bootId\":{:?},\"app\":{:?},\"writePaths\":{:?},\"readPaths\":{:?},\"networkPorts\":{:?},\"networkUnrestricted\":{},\"bindPorts\":{:?},\"meshPeers\":{:?},\"ruleset\":{:?},\"timestamp\":{}}}",
        boot_id(), policy.app_name, policy.write_paths, policy.read_paths, policy.network_ports, policy.network_unrestricted, policy.bind_ports, policy.mesh_peers, ruleset_status, now
    );
}

/// Checked before falling back to "warn and run unrestricted" anywhere in
/// main(). Local dev (Mac/Docker Desktop's linuxkit VM) never enforces
/// Landlock at the kernel level — see capability-enforcement.mjs — so that
/// fallback stays the default. Production deploys set this to opt into the
/// opposite: no enforcement, no exec, full stop, rather than silently running
/// an agent with the capability policy unenforced.
fn enforcement_required() -> bool {
    matches!(env::var("BERTH_REQUIRE_ENFORCEMENT").as_deref(), Ok("1") | Ok("true"))
}

/// The one exit path taken when BERTH_REQUIRE_ENFORCEMENT is set and the
/// kernel didn't (fully) enforce the policy — logged as its own greppable
/// audit event, distinct from log_audit_event's per-boot record, since this
/// is the refusal itself rather than a record of what was granted.
fn log_enforcement_refused_event(app_name: &str, reason: &str) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    eprintln!(
        "[agent-init] {{\"event\":\"capability_enforcement_refused\",\"app\":{app_name:?},\"reason\":{reason:?},\"timestamp\":{now}}}"
    );
}

/// Separate structured line from log_audit_event above: the capability drop
/// happens in main(), after apply_policy() has already returned (or failed),
/// so it can't be folded into that single per-policy audit line without
/// restructuring apply_policy's control flow for no real benefit — two
/// greppable JSON lines per boot instead of one.
fn log_caps_dropped_event(app_name: &str, dropped: bool) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    eprintln!(
        "[agent-init] {{\"event\":\"capabilities_dropped\",\"bootId\":{:?},\"app\":{app_name:?},\"dropped\":{dropped},\"timestamp\":{now}}}",
        boot_id()
    );
}

/// Structured line for the seccomp filter in seccomp.rs — the UDP/raw-socket
/// half of deny-by-default network access, which Landlock cannot express.
/// Separate from log_audit_event for the same reason log_caps_dropped_event
/// is: it happens in main(), after apply_policy() has returned.
fn log_seccomp_event(app_name: &str, applied: bool, detail: &str) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    eprintln!(
        "[agent-init] {{\"event\":\"network_seccomp_filter\",\"bootId\":{:?},\"app\":{app_name:?},\"applied\":{applied},\"detail\":{detail:?},\"timestamp\":{now}}}",
        boot_id()
    );
}

/// Drops the two capabilities this repo's `container.ts` adds beyond Docker's
/// own default set (SYS_ADMIN for semantic-fs's FUSE mount, NET_ADMIN for
/// mesh-daemon's wg0), plus CAP_NET_RAW, which nothing adds because Docker
/// grants it by default — and which is what lets a process open AF_PACKET
/// sockets and speak TCP/IP in userspace, never calling the connect(2) that
/// Landlock's AccessNet::ConnectTcp rule is watching for. Dropping it is half
/// of REMEDIATION.md 1.2; the seccomp filter in seccomp.rs is the other half
/// (it also covers UDP, which no capability gates at all).
///
/// The bounding set is the one that matters across the exec() below: for a
/// uid-0 process exec'ing a file with no file capabilities, the kernel's
/// "root rule" recomputes the permitted set from the bounding set, so
/// dropping from permitted/effective here would simply be undone a few lines
/// later. This is not the whole bounding set. Landlock's
/// restrict_self() above narrows LSM-enforced syscall access but does
/// nothing to the process's Linux capability set — those are two orthogonal
/// kernel enforcement mechanisms. Since these containers run every process
/// as root with no USER directive, a container-level `CapAdd` grant would
/// otherwise reach the resident app's own process just as much as the
/// pre-exec daemon it was actually intended for. The bounding set is a hard
/// ceiling a process can never widen for itself or anything it execs —
/// dropping these two here is what keeps "declared capability, enforced by
/// the kernel" true for Linux capabilities, not just for Landlock's
/// filesystem/network-port rules.
///
/// Deliberately NOT `caps::clear` (drop everything): a real CI run on a
/// kernel where Landlock is actually enforced caught that dropping the
/// entire set also strips CAP_DAC_OVERRIDE, which root normally relies on to
/// write into a bind-mounted directory it doesn't literally own (e.g. this
/// repo's own CI checkout, owned by a non-root runner user) — every write
/// inside the declared /workspace path started failing with EACCES. Docker's
/// own default capability set (CAP_DAC_OVERRIDE, CAP_CHOWN, CAP_FOWNER, ...)
/// is otherwise left alone: the two explicitly-added ones, plus NET_RAW,
/// are what get revoked before the resident app runs. Dropping NET_RAW also
/// means ping(8) no longer works inside a sandbox — an acceptable trade for
/// closing a userspace-networking bypass, and worth knowing when a network
/// probe from inside a container comes back "Operation not permitted."
/// See docs/mesh-reference.md.
fn drop_all_capabilities() -> Result<(), Box<dyn std::error::Error>> {
    for cap in [Capability::CAP_SYS_ADMIN, Capability::CAP_NET_ADMIN, Capability::CAP_NET_RAW] {
        // caps::drop() on a capability that was never in the set (e.g.
        // CAP_NET_ADMIN for an app that never declared network:peer:*) is a
        // documented no-op, not an error.
        caps::drop(None, CapSet::Bounding, cap)?;
        caps::drop(None, CapSet::Inheritable, cap)?;
        caps::drop(None, CapSet::Ambient, cap)?;
    }
    Ok(())
}

fn main() {
    let policy_path =
        env::var("BERTH_CAPABILITY_POLICY").unwrap_or_else(|_| ".berth/capability-policy.json".to_string());

    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("[agent-init] usage: agent-init <command> [args...]");
        std::process::exit(1);
    }

    let require_enforcement = enforcement_required();

    // Second element: whether this app declared no network access at all, and
    // so should also get the UDP/raw-socket seccomp filter below. Unknown on
    // the Err path (there's no policy to read it from), and false there —
    // that path only survives at all when enforcement isn't required.
    let (app_name, deny_datagram_sockets) = match apply_policy(&policy_path) {
        Ok((policy, ruleset_status)) => {
            if require_enforcement && ruleset_status != RulesetStatus::FullyEnforced {
                let reason = format!("landlock ruleset status was {ruleset_status:?}, not FullyEnforced");
                eprintln!(
                    "[agent-init] FATAL: BERTH_REQUIRE_ENFORCEMENT is set but {reason} for \"{}\" — refusing to exec unrestricted.",
                    policy.app_name
                );
                log_enforcement_refused_event(&policy.app_name, &reason);
                std::process::exit(1);
            }
            eprintln!(
                "[agent-init] restricted \"{}\" — write access allowed only under: {} (declared capabilities: {})",
                policy.app_name,
                policy.write_paths.join(", "),
                policy.declared_capabilities.join(", "),
            );
            // Only for apps with *no* declared outbound network at all. An
            // app that declared even one port needs DNS (UDP 53) for that
            // port to be reachable by name, and Landlock's per-port model
            // can't express "UDP 53 only" — see seccomp.rs's header.
            let no_network_declared = !policy.network_unrestricted && policy.network_ports.is_empty();
            (policy.app_name, no_network_declared)
        }
        Err(err) => {
            if require_enforcement {
                let reason = format!("could not apply capability policy from {policy_path} ({err})");
                eprintln!("[agent-init] FATAL: BERTH_REQUIRE_ENFORCEMENT is set but {reason} — refusing to exec unrestricted.");
                log_enforcement_refused_event("unknown", &reason);
                std::process::exit(1);
            }
            eprintln!(
                "[agent-init] WARNING: could not apply capability policy from {policy_path} ({err}) — continuing unrestricted."
            );
            ("unknown".to_string(), false)
        }
    };

    // Runs regardless of whether apply_policy() above succeeded — a process
    // that inherited the container's full root capability set is exactly as
    // dangerous whether or not Landlock's filesystem/network rules also
    // applied, so this isn't gated on that Ok/Err branch.
    let caps_dropped = drop_all_capabilities().is_ok();
    if caps_dropped {
        eprintln!("[agent-init] dropped capability bounding/inheritable/ambient sets before exec");
    } else {
        eprintln!("[agent-init] WARNING: could not drop capabilities before exec — continuing anyway");
    }
    log_caps_dropped_event(&app_name, caps_dropped);

    // Last thing before exec, and deliberately after the capability drop:
    // installing this filter sets PR_SET_NO_NEW_PRIVS, and capset(2) is not
    // in the filter's denied set either way, but ordering the irrevocable
    // restrictions last keeps "everything agent-init does to itself happens
    // before it becomes someone else's process" true by construction.
    if deny_datagram_sockets {
        match seccomp::install_no_udp_no_raw_filter() {
            Ok(()) => {
                eprintln!(
                    "[agent-init] no network capability declared — UDP and raw sockets refused by seccomp for \"{app_name}\""
                );
                log_seccomp_event(&app_name, true, "udp_and_raw_sockets_denied");
            }
            Err(err) => {
                let detail = format!("could not install seccomp filter ({err})");
                if require_enforcement {
                    eprintln!(
                        "[agent-init] FATAL: BERTH_REQUIRE_ENFORCEMENT is set but {detail} for \"{app_name}\" — refusing to exec with unrestricted UDP."
                    );
                    log_seccomp_event(&app_name, false, &detail);
                    log_enforcement_refused_event(&app_name, &detail);
                    std::process::exit(1);
                }
                eprintln!("[agent-init] WARNING: {detail} — continuing with UDP and raw sockets available.");
                log_seccomp_event(&app_name, false, &detail);
            }
        }
    } else {
        log_seccomp_event(&app_name, false, "network capability declared — datagram sockets left open for DNS");
    }

    let err = Command::new(&args[0]).args(&args[1..]).exec();
    eprintln!("[agent-init] failed to exec {args:?}: {err}");
    std::process::exit(1);
}

/// The write-ish filesystem rights handed to `handle_access()` and granted on
/// each declared write path. Split out of apply_policy() so the unit test
/// below can assert what's in the set without needing a kernel that actually
/// enforces Landlock — the environment where this was originally wrong
/// (Docker Desktop's linuxkit VM, Landlock absent from the LSM stack) is
/// exactly the one where an end-to-end denial test proves nothing.
fn write_access_rights() -> BitFlags<AccessFs> {
    AccessFs::from_write(ABI::V3)
}

fn apply_policy(policy_path: &str) -> Result<(CapabilityPolicy, RulesetStatus), Box<dyn std::error::Error>> {
    let raw = std::fs::read_to_string(policy_path)?;
    let policy: CapabilityPolicy = serde_json::from_str(&raw)?;

    // Write-ish access rights are always handled. Read stays opt-in —
    // handle_access()'ing an access type makes it denied-by-default
    // everywhere except where a rule grants it, so it's only turned on when
    // the policy actually declared at least one read path (see
    // generate-capability-policy.ts's BASELINE_READ_PATHS comment for why
    // read scoping, once enabled, still needs a broad baseline rather than
    // just the app's own declared paths).
    //
    // Network is deny-by-default: unless the app explicitly declared
    // `network:connect:*` (network_unrestricted), it gets a network ruleset
    // with only its declared ports allowed — zero declared ports means zero
    // outbound TCP, full stop. This is the PRD's "deny-by-default network
    // policies" claim, enforced by the kernel rather than left to whatever
    // the container's network namespace happens to allow.
    //
    // Landlock only enforces the rights named in handled_access_fs — a right
    // that isn't handled is *permitted everywhere*, so an omission here is a
    // silent hole, not a smaller ruleset. AccessFs::from_write(ABI::V3) is
    // used rather than an enumerated list precisely so a right added to a
    // future ABI can't be forgotten: the enumerated version of this omitted
    // Truncate (V3), which made `open(O_WRONLY)` outside a declared path fail
    // while `truncate(path, 0)` on the same file succeeded — destroying its
    // contents just as effectively.
    //
    // Not handled, deliberately: Execute and IoctlDev (both from_read/V5
    // territory). Handling Execute would deny exec of every interpreter and
    // shell outside the declared read paths — /bin and /sbin are not in
    // BASELINE_READ_PATHS (see generate-capability-policy.ts), so it would
    // break every app that shells out. That's a real gap; it needs the
    // baseline exec set worked out first and is tracked separately.
    //
    // Ruleset::default() is best-effort, so a kernel whose Landlock ABI
    // predates V3 downgrades to the rights it does support instead of
    // failing the boot outright.
    let write_access = write_access_rights();
    let read_access = AccessFs::ReadFile | AccessFs::ReadDir;
    let net_access = AccessNet::ConnectTcp;

    let restrict_reads = !policy.read_paths.is_empty();
    let restrict_network = !policy.network_unrestricted;

    let mut builder = Ruleset::default().handle_access(write_access)?;
    if restrict_reads {
        builder = builder.handle_access(read_access)?;
    }
    if restrict_network {
        builder = builder.handle_access(AccessNet::from_all(ABI::V4))?;
    }
    let mut ruleset = builder.create()?;

    for path in &policy.write_paths {
        // PathFd::new() opens the path via a real file descriptor - it must
        // already exist on disk, or this (and the write grant along with
        // it) silently fails below. A declared write path like /workspace
        // is never guaranteed to exist yet (no Dockerfile step creates it,
        // and dev's bind-mount is the only thing that happens to), so this
        // process - not yet Landlock-restricted itself at this point in
        // apply_policy() - creates it first. Without this, the resident
        // app's own first `mkdir(WORKSPACE_ROOT)` call fails with EACCES:
        // creating a not-yet-existing /workspace is an operation on its
        // *parent* (/), which was never granted, not on /workspace itself.
        if let Err(err) = std::fs::create_dir_all(path) {
            eprintln!("[agent-init] WARNING: couldn't create \"{path}\" ahead of granting write access ({err})");
        }
        match PathFd::new(path) {
            Ok(fd) => {
                ruleset = ruleset.add_rule(PathBeneath::new(fd, write_access))?;
            }
            Err(err) => {
                eprintln!("[agent-init] WARNING: couldn't open \"{path}\" to grant write access ({err}), skipping");
            }
        }
    }

    if restrict_reads {
        for path in &policy.read_paths {
            // Same reasoning as the write-path loop above: a declared read
            // path (e.g. another app's /workspace) isn't guaranteed to exist
            // yet when this app's own agent-init runs — in a multi-app
            // container, entrypoint.sh starts every app's chain concurrently
            // with no ordering barrier, so whichever app actually creates
            // the directory (typically the one with a *write* grant there)
            // may not have run yet. PathFd::new() below would then fail with
            // ENOENT and silently skip the grant — permanently, since the
            // ruleset is finalized moments later by restrict_self() — even
            // though the path exists by the time this app actually tries to
            // read from it.
            if let Err(err) = std::fs::create_dir_all(path) {
                eprintln!("[agent-init] WARNING: couldn't create \"{path}\" ahead of granting read access ({err})");
            }
            match PathFd::new(path) {
                Ok(fd) => {
                    ruleset = ruleset.add_rule(PathBeneath::new(fd, read_access))?;
                }
                Err(err) => {
                    eprintln!("[agent-init] WARNING: couldn't open \"{path}\" to grant read access ({err}), skipping");
                }
            }
        }
    }

    if restrict_network {
        for &port in &policy.network_ports {
            ruleset = ruleset.add_rule(NetPort::new(port, net_access))?;
        }
        // Bind grants are independent of network_ports' ConnectTcp ones —
        // an app that needs to listen on a port (e.g. the HTTP RPC bridge)
        // doesn't necessarily need to *dial out* on it too. Without this,
        // AccessNet::from_all above denies bind() by default the same as
        // connect(), and every listen() call in the process fails with
        // EPERM the moment Landlock is actually enforced (silently a no-op
        // wherever it isn't, e.g. Docker Desktop's linuxkit VM kernel —
        // which is exactly why this was missed until CI's real kernel
        // caught it).
        for &port in &policy.bind_ports {
            ruleset = ruleset.add_rule(NetPort::new(port, AccessNet::BindTcp))?;
        }
    }

    let status = ruleset.restrict_self()?;
    eprintln!(
        "[agent-init] landlock restrict_self() status: ruleset={:?} no_new_privs={:?}",
        status.ruleset, status.no_new_privs
    );
    log_audit_event(&policy, &format!("{:?}", status.ruleset));
    let ruleset_status = status.ruleset;
    Ok((policy, ruleset_status))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Landlock only enforces the rights present in handled_access_fs; an
    // unhandled right is permitted everywhere, so this set going quietly
    // narrower is a security regression that no allow-path test would catch.
    #[test]
    fn write_access_set_covers_every_write_ish_right_through_abi_v3() {
        let rights = write_access_rights();
        for expected in [
            AccessFs::WriteFile,
            AccessFs::RemoveDir,
            AccessFs::RemoveFile,
            AccessFs::MakeChar,
            AccessFs::MakeDir,
            AccessFs::MakeReg,
            AccessFs::MakeSock,
            AccessFs::MakeFifo,
            AccessFs::MakeBlock,
            AccessFs::MakeSym,
            // The one that was missing: without it, `open(O_WRONLY)` outside a
            // declared write path is refused while `truncate(path, 0)` on that
            // same path succeeds.
            AccessFs::Truncate,
        ] {
            assert!(rights.contains(expected), "{expected:?} is not handled — it would be permitted everywhere");
        }
    }

    // Read rights are a separate, opt-in handled set (see apply_policy). If a
    // read right leaked into the write set it would be handled unconditionally
    // and denied for apps that declared no filesystem:read capability at all,
    // silently breaking them rather than failing loudly.
    #[test]
    fn write_access_set_contains_no_read_rights() {
        let rights = write_access_rights();
        for unexpected in [AccessFs::ReadFile, AccessFs::ReadDir, AccessFs::Execute] {
            assert!(!rights.contains(unexpected), "{unexpected:?} must not be in the unconditional write set");
        }
    }
}
