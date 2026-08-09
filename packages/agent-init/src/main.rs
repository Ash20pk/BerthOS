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
use std::path::Path;
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

/// Structured line for the seccomp filters in seccomp.rs — the UDP/raw-socket
/// half of deny-by-default network access, and the namespace-creation refusal
/// that keeps the capability drop below irreversible. `event` names which one,
/// so the two are independently greppable. Separate from log_audit_event for
/// the same reason log_caps_dropped_event is: they happen in main(), after
/// apply_policy() has returned.
fn log_seccomp_event(event: &str, app_name: &str, applied: bool, detail: &str) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    eprintln!(
        "[agent-init] {{\"event\":{event:?},\"bootId\":{:?},\"app\":{app_name:?},\"applied\":{applied},\"detail\":{detail:?},\"timestamp\":{now}}}",
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
/// pre-exec daemon it was actually intended for. Dropping these three here is
/// what keeps "declared capability, enforced by the kernel" true for Linux
/// capabilities, not just for Landlock's filesystem/network-port rules.
///
/// The bounding set is a ceiling a process can never widen for itself or
/// anything it execs — but only within its own user namespace. An earlier
/// version of this comment called it a hard ceiling full stop, and that was
/// wrong: `unshare(CLONE_NEWUSER)` needs no privilege and hands its creator a
/// fresh CAP_FULL_SET bounding set inside the new namespace, which was enough
/// to mount(2) again (REMEDIATION.md 1.3). The drop below is only a ceiling
/// because seccomp::install_no_new_namespaces_filter() runs right after it and
/// refuses namespace creation outright. The two are a pair; neither is worth
/// much alone.
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

/// The identity this app was provisioned with by entrypoint.sh's
/// provision_app_identity() — uid/gid `10000 + index`, plus the supplementary
/// groups that reach the resources shared by design (`berth` for /context and
/// the daemon control sockets, `tty` for a terminal:* app's pty).
///
/// Absent means "stay root", and that is a supported state, not a failure:
/// provisioning warns and continues if adduser fails, `agent-init` is run
/// directly by several tests, and neither should be forced into a uid that
/// doesn't exist. Step 2 of docs/per-app-uid-design.md.
struct AppIdentity {
    uid: u32,
    gid: u32,
    supplementary_gids: Vec<u32>,
}

fn app_identity() -> Option<AppIdentity> {
    parse_app_identity(
        env::var("BERTH_APP_UID").ok().as_deref(),
        env::var("BERTH_APP_GID").ok().as_deref(),
        env::var("BERTH_APP_SUPPLEMENTARY_GIDS").ok().as_deref().unwrap_or(""),
    )
}

/// Split from app_identity() so the unit tests below can exercise it without
/// mutating the process environment — cargo runs tests as threads of one
/// process, so a test that set BERTH_APP_UID would be visible to every other
/// test running at the same time.
///
/// Anything malformed yields None, i.e. "stay root". A uid this process
/// cannot parse is not one it should try to become, and refusing to boot over
/// it would be a worse trade than the status quo it falls back to.
fn parse_app_identity(uid: Option<&str>, gid: Option<&str>, supplementary: &str) -> Option<AppIdentity> {
    let uid: u32 = uid?.trim().parse().ok()?;
    let gid: u32 = gid?.trim().parse().ok()?;
    // Zero is not an identity to switch *to* — it's the one being left. It
    // reaches here when provisioning failed and something exported a
    // placeholder, and treating it as valid would log a successful "drop" to
    // root.
    if uid == 0 || gid == 0 {
        return None;
    }
    let supplementary_gids = supplementary
        .split(',')
        .filter_map(|entry| entry.trim().parse::<u32>().ok())
        .filter(|gid| *gid != 0)
        .collect();
    Some(AppIdentity { uid, gid, supplementary_gids })
}

/// Becomes the app's uid, irreversibly, and verifies it.
///
/// Order is the whole of the correctness here, and each call is what removes
/// the privilege the previous one needed: `setgroups` first (it needs
/// CAP_SETGID), then `setresgid`, then `setresuid` last. Doing it the other
/// way round leaves a process that has dropped to an unprivileged uid while
/// still carrying root's supplementary groups — which for this container
/// means gid 0, the group that owns everything.
///
/// All three of real, effective, and saved are set. Setting only the
/// effective uid would leave the saved uid at 0 and make the whole thing a
/// `setuid(0)` away from undone, which is the failure mode this is meant to
/// prevent rather than reproduce.
///
/// No `capset` back to root is possible afterward: the kernel clears the
/// permitted and effective capability sets when a process's uid moves away
/// from 0 with SECBIT_KEEP_CAPS unset (it is unset — nothing here sets it).
/// That is relied on, but not trusted: the verification below re-reads the
/// uid and tries `setuid(0)`, because "the kernel does this" is exactly the
/// kind of assumption REMEDIATION.md 1.3 was made of.
fn switch_to_app_identity(identity: &AppIdentity) -> Result<(), String> {
    let mut groups: Vec<libc::gid_t> = vec![identity.gid as libc::gid_t];
    for gid in &identity.supplementary_gids {
        if !groups.contains(&(*gid as libc::gid_t)) {
            groups.push(*gid as libc::gid_t);
        }
    }

    // SAFETY: each of these is a plain syscall wrapper over values this
    // process owns; `groups` outlives the setgroups() call it is passed to.
    unsafe {
        if libc::setgroups(groups.len(), groups.as_ptr()) != 0 {
            return Err(format!("setgroups({groups:?}) failed: {}", std::io::Error::last_os_error()));
        }
        if libc::setresgid(identity.gid, identity.gid, identity.gid) != 0 {
            return Err(format!("setresgid({}) failed: {}", identity.gid, std::io::Error::last_os_error()));
        }
        if libc::setresuid(identity.uid, identity.uid, identity.uid) != 0 {
            return Err(format!("setresuid({}) failed: {}", identity.uid, std::io::Error::last_os_error()));
        }

        // Verification, not decoration. A silent no-op here would hand the
        // app root while every log line claimed otherwise — the worst
        // possible outcome, since it is indistinguishable from success.
        if libc::getuid() != identity.uid || libc::geteuid() != identity.uid {
            return Err(format!(
                "uid is {}/{} after setresuid({}) — the drop did not take",
                libc::getuid(),
                libc::geteuid(),
                identity.uid
            ));
        }
        if libc::setuid(0) == 0 {
            return Err("setuid(0) succeeded after the drop — the uid change is reversible".to_string());
        }
    }
    Ok(())
}

/// One structured line for the uid drop, matching the other audit events.
fn log_uid_dropped_event(app_name: &str, uid: u32, gid: u32, dropped: bool, detail: &str) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    eprintln!(
        "[agent-init] {{\"event\":\"app_uid_applied\",\"bootId\":{:?},\"app\":{app_name:?},\"uid\":{uid},\"gid\":{gid},\"dropped\":{dropped},\"detail\":{detail:?},\"timestamp\":{now}}}",
        boot_id()
    );
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

    // Immediately after the drop above, and for every app rather than
    // conditionally: without this, the drop is not a ceiling at all. Creating
    // a user namespace needs no privilege, and the kernel hands its creator a
    // full capability set — including a fresh CAP_FULL_SET bounding set —
    // inside the new namespace, which is enough to mount(2) again. Docker's
    // own default seccomp profile blocks this, but stops doing so when the
    // container holds CAP_SYS_ADMIN, which every Berth container does for
    // semantic-fs's FUSE mount. See seccomp.rs's header and REMEDIATION.md 1.3.
    match seccomp::install_no_new_namespaces_filter() {
        Ok(()) => {
            eprintln!("[agent-init] namespace creation (unshare/clone/setns) refused by seccomp for \"{app_name}\"");
            log_seccomp_event("namespace_seccomp_filter", &app_name, true, "new_namespaces_denied");
        }
        Err(err) => {
            let detail = format!("could not install namespace seccomp filter ({err})");
            if require_enforcement {
                eprintln!(
                    "[agent-init] FATAL: BERTH_REQUIRE_ENFORCEMENT is set but {detail} for \"{app_name}\" — refusing to exec, since the capability drop above would be reversible by the app itself."
                );
                log_seccomp_event("namespace_seccomp_filter", &app_name, false, &detail);
                log_enforcement_refused_event(&app_name, &detail);
                std::process::exit(1);
            }
            eprintln!("[agent-init] WARNING: {detail} — continuing with the capability drop reversible via unshare(CLONE_NEWUSER).");
            log_seccomp_event("namespace_seccomp_filter", &app_name, false, &detail);
        }
    }

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
                log_seccomp_event("network_seccomp_filter", &app_name, true, "udp_and_raw_sockets_denied");
            }
            Err(err) => {
                let detail = format!("could not install seccomp filter ({err})");
                if require_enforcement {
                    eprintln!(
                        "[agent-init] FATAL: BERTH_REQUIRE_ENFORCEMENT is set but {detail} for \"{app_name}\" — refusing to exec with unrestricted UDP."
                    );
                    log_seccomp_event("network_seccomp_filter", &app_name, false, &detail);
                    log_enforcement_refused_event(&app_name, &detail);
                    std::process::exit(1);
                }
                eprintln!("[agent-init] WARNING: {detail} — continuing with UDP and raw sockets available.");
                log_seccomp_event("network_seccomp_filter", &app_name, false, &detail);
            }
        }
    } else {
        log_seccomp_event("network_seccomp_filter", &app_name, false, "network capability declared — datagram sockets left open for DNS");
    }

    // Genuinely last, after Landlock, the capability drop, and both seccomp
    // filters — every one of those needs root, and none of them can be
    // reapplied once this returns. See docs/per-app-uid-design.md's ordering
    // note. Landlock's domain is inode-based and seccomp's filter is
    // process-wide; neither cares about the uid change, and both survive it
    // and the exec() below.
    match app_identity() {
        Some(identity) => match switch_to_app_identity(&identity) {
            Ok(()) => {
                eprintln!(
                    "[agent-init] running \"{app_name}\" as uid {} (gid {}, supplementary {:?}) — no longer root",
                    identity.uid, identity.gid, identity.supplementary_gids
                );
                log_uid_dropped_event(&app_name, identity.uid, identity.gid, true, "irreversible");
            }
            Err(detail) => {
                // Fail closed wherever enforcement is required. A half-applied
                // identity — supplementary groups set, uid not — is a worse
                // state than either end of it, and there is no way to tell
                // from here which half took.
                if require_enforcement {
                    eprintln!(
                        "[agent-init] FATAL: BERTH_REQUIRE_ENFORCEMENT is set but the uid drop for \"{app_name}\" failed ({detail}) — refusing to exec as root."
                    );
                    log_uid_dropped_event(&app_name, identity.uid, identity.gid, false, &detail);
                    log_enforcement_refused_event(&app_name, &detail);
                    std::process::exit(1);
                }
                eprintln!("[agent-init] WARNING: could not run \"{app_name}\" as uid {} ({detail}) — continuing as root.", identity.uid);
                log_uid_dropped_event(&app_name, identity.uid, identity.gid, false, &detail);
            }
        },
        None => {
            // Not a warning. entrypoint.sh exports nothing when provisioning
            // failed or was never attempted (agent-init run directly by a
            // test), and root is what every Berth container did until Step 2.
            log_uid_dropped_event(&app_name, 0, 0, false, "no BERTH_APP_UID — running as root");
        }
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

/// The same rights, narrowed to those Landlock considers meaningful on a
/// non-directory. This exists because getting it wrong is silent and
/// expensive, and it already cost one failed attempt at REMEDIATION.md 1.15.
///
/// `PathBeneath`'s compatibility pass (landlock 0.4's `fs.rs`) fstat()s the
/// rule's target and, if it isn't a directory, masks the requested access down
/// to `ACCESS_FILE` — `ReadFile | WriteFile | Execute | Truncate | IoctlDev |
/// ResolveUnix`. Everything else in `from_write(V3)` is directory-only
/// (`MakeReg`, `MakeDir`, `RemoveFile`, `Refer`, ...). When that mask changes
/// anything the crate returns `CompatResult::Partial`, its own source noting
/// "Linux would return EINVAL" — and under `BestEffort` that downgrades the
/// whole ruleset's status to `PartiallyEnforced`.
///
/// Which matters more than a status field suggests: `main()` refuses to exec
/// at all unless the status is exactly `FullyEnforced` when
/// `BERTH_REQUIRE_ENFORCEMENT` is set, i.e. in every production image. So
/// adding one rule on one device node — `/dev/null`, `/dev/ptmx` — with the
/// directory rights would turn a working app into an unbootable one, in
/// production only, for a reason nothing in the error message points at. That
/// is exactly what happened when 1.15 was first attempted.
///
/// Passing the narrowed set for files means the crate has nothing to mask, so
/// no downgrade is reported and the rule is identical to what the kernel would
/// have accepted anyway.
fn file_write_access_rights() -> BitFlags<AccessFs> {
    write_access_rights() & AccessFs::from_file(ABI::V3)
}

/// Which of the two above a given path needs. A symlink is followed, matching
/// what `PathFd::new()` does a moment later — `/dev/ptmx` is a symlink to the
/// `pts/ptmx` character device, and classifying it by the link rather than the
/// target would pick the wrong set.
fn access_rights_for(path: &str) -> BitFlags<AccessFs> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => write_access_rights(),
        // A path that can't be stat()'d gets the directory set: PathFd::new()
        // is about to fail on it too, and the grant is skipped either way.
        Err(_) => write_access_rights(),
        _ => file_write_access_rights(),
    }
}

/// Path prefixes a declared write path may live under. A deliberate duplicate
/// of ALLOWED_FILESYSTEM_SCOPE_PREFIXES in @berth/manifest-schema's
/// capability.ts — that's the layer that rejects a bad `berth.yml` with a
/// line-numbered error, but *this* process is the one that runs
/// create_dir_all() as uid 0 with CAP_SYS_ADMIN, so it re-checks rather than
/// trusting a policy file it didn't write. In `berth dev` those mkdirs land on
/// the developer's host through the bind mount, which is what makes trusting
/// the file upstream a bad trade.
///
/// Applied to write paths only. Read paths are not created (see the read loop
/// below) and the policy's readPaths list mixes declared paths with
/// generate-capability-policy.ts's own baseline — /usr, /bin, /sbin, /lib,
/// /etc, /proc, /dev — which this list would reject; the declared half is validated at
/// manifest-validation time instead.
const ALLOWED_WRITE_PATH_PREFIXES: [&str; 4] = ["/workspace", "/context", "/tmp", "/app"];

/// Device paths the *compiler* injects — never something a `berth.yml` can
/// declare, which is why `@berth/manifest-schema`'s copy of the prefix list
/// above deliberately does not grow to match. `/dev/null` goes to every app;
/// `/dev/pts` and `/dev/ptmx` only to one declaring `terminal:*` (see
/// generate-capability-policy.ts, which also records why `/dev/tty` is not
/// here: it cannot be opened without a controlling terminal, and the pty it
/// would resolve to is already covered).
///
/// Matched exactly rather than as prefixes. `/dev` must stay rejected: it is a
/// tmpfs holding every device node the container has, and a prefix match would
/// turn a four-entry convenience into a grant over all of them.
const ALLOWED_WRITE_DEVICE_PATHS: [&str; 3] = ["/dev/null", "/dev/pts", "/dev/ptmx"];

/// The app's own runtime directory, holding the RPC socket it binds in
/// multi-app mode. Also compiler-injected rather than declarable, but unlike
/// the device paths above it is checked against *this* app's name rather than
/// as a shared prefix: `/run/berth` as a prefix would let a policy claiming to
/// be one app grant write access to every other app's socket directory, which
/// is precisely the boundary this directory exists to draw (REMEDIATION.md
/// 1.4). `/run` itself, and `/run/berth`, stay rejected.
fn app_run_dir(app_name: &str) -> String {
    format!("/run/berth/{app_name}")
}

/// Split out of apply_policy() so the unit tests below can exercise it without
/// a kernel that enforces Landlock or a real policy file.
fn is_allowed_write_path(path: &str, app_name: &str) -> bool {
    if !path.starts_with('/') || path == "/" || path.contains('\0') {
        return false;
    }
    if path.split('/').skip(1).any(|segment| segment.is_empty() || segment == "." || segment == ".." || segment == "*") {
        return false;
    }
    if ALLOWED_WRITE_DEVICE_PATHS.contains(&path) {
        return true;
    }
    // A name with a separator or a dot segment in it would make app_run_dir()
    // name somewhere other than one directory under /run/berth. The segment
    // check above already refuses any *path* like that, so this is belt and
    // braces on a policy file this process deliberately does not trust.
    if !app_name.is_empty() && !app_name.contains('/') && app_name != "." && app_name != ".." {
        let own_run_dir = app_run_dir(app_name);
        if path == own_run_dir || path.starts_with(&format!("{own_run_dir}/")) {
            return true;
        }
    }
    ALLOWED_WRITE_PATH_PREFIXES
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}

/// Hands a directory this process just created to the app's own uid, so that
/// a write path Landlock grants is one DAC also allows. A no-op when no app
/// identity was provisioned, which is the pre-Step-2 world.
fn give_to_app(path: &str) {
    let Some(identity) = app_identity() else { return };
    if let Err(err) = std::os::unix::fs::chown(path, Some(identity.uid), Some(identity.gid)) {
        eprintln!(
            "[agent-init] WARNING: created \"{path}\" but couldn't give it to uid {} ({err}) — writes there will fail with EACCES despite the Landlock grant",
            identity.uid
        );
    }
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
    // territory). Handling Execute would make exec denied-by-default and
    // permitted only under paths granted an Execute rule — which is a real
    // gap, and needs the baseline exec set worked out first rather than
    // inheriting the read baseline wholesale. Tracked separately.
    //
    // Note this is a different question from whether an interpreter is
    // *readable*: with read scoping on, execve() of a file outside every read
    // rule already fails with EACCES, which is why /bin and /sbin had to be
    // added to BASELINE_READ_PATHS (see generate-capability-policy.ts).
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
        // Refused before create_dir_all(), not after: the mkdir is the
        // dangerous half. A path outside the allowlist is dropped from the
        // ruleset entirely rather than failing the boot — the app then hits a
        // real EACCES on its first write there, which is a truthful outcome,
        // whereas exiting would turn a bad capability line into a container
        // that won't start at all long after `berth test` should have caught
        // it (see ALLOWED_WRITE_PATH_PREFIXES).
        if !is_allowed_write_path(path, &policy.app_name) {
            eprintln!(
                "[agent-init] WARNING: refusing to create or grant write access to \"{path}\" — outside the allowed prefixes {} (plus {}). Fix the filesystem:write capability in berth.yml.",
                ALLOWED_WRITE_PATH_PREFIXES.join(", "),
                app_run_dir(&policy.app_name)
            );
            continue;
        }
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
        //
        // Skipped when the path already exists, which is not just an
        // optimisation: several of these are device nodes now (/dev/null,
        // /dev/ptmx), and create_dir_all() on an existing character device
        // fails with ENOTDIR — a warning about being unable to create
        // something that is already there, on every single boot.
        if !Path::new(path).exists() {
            if let Err(err) = std::fs::create_dir_all(path) {
                eprintln!("[agent-init] WARNING: couldn't create \"{path}\" ahead of granting write access ({err})");
            } else {
                // A directory this process just created as root, for an app
                // that is about to stop being root, would otherwise be
                // granted by Landlock and refused by DAC — an EACCES on a
                // path the audit line says was allowed, which is the most
                // confusing failure available.
                //
                // Only paths created here. An existing one belongs to
                // somebody — /tmp, /context, a bind mount — and taking
                // ownership of it is not agent-init's call to make (see
                // Blocker 1 in docs/per-app-uid-design.md).
                give_to_app(path);
            }
        }
        match PathFd::new(path) {
            Ok(fd) => {
                // Per path, not the one `write_access` set: a rule carrying
                // directory-only rights on a device node downgrades the whole
                // ruleset to PartiallyEnforced, which a production image
                // refuses to boot on. See file_write_access_rights().
                ruleset = ruleset.add_rule(PathBeneath::new(fd, access_rights_for(path)))?;
            }
            Err(err) => {
                eprintln!("[agent-init] WARNING: couldn't open \"{path}\" to grant write access ({err}), skipping");
            }
        }
    }

    if restrict_reads {
        for path in &policy.read_paths {
            // Deliberately NOT created, unlike the write loop above: a read
            // grant needs no directory to exist for the app to work, so
            // creating one is a pure side effect of *declaring* a capability
            // — as uid 0, and in `berth dev` on the developer's host through
            // the bind mount. A missing read path is reported instead.
            //
            // The cost is real and worth naming: PathFd::new() fails with
            // ENOENT and the grant is skipped permanently, since the ruleset
            // is finalized moments later by restrict_self(). That bites in a
            // multi-app container, where entrypoint.sh starts every app's
            // chain concurrently with no ordering barrier — an app declaring
            // filesystem:read on a sibling's directory can run before the
            // sibling (the one with the *write* grant) has created it. The
            // fix for that is ordering, not mkdir'ing arbitrary manifest
            // paths as root; until then the warning below says exactly what
            // was lost rather than papering over it.
            match PathFd::new(path) {
                Ok(fd) => {
                    ruleset = ruleset.add_rule(PathBeneath::new(fd, read_access))?;
                }
                Err(err) => {
                    eprintln!(
                        "[agent-init] WARNING: couldn't open \"{path}\" to grant read access ({err}) — reads there will be DENIED for the whole life of this process, since the ruleset is about to be sealed. Create the path before boot if the app needs it."
                    );
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

    // "Stay root" is the fallback for every shape of missing or malformed
    // input, and it has to be, since agent-init is run directly by several
    // tests and by any container where provisioning warned and continued.
    #[test]
    fn a_missing_or_malformed_identity_means_staying_root() {
        for (uid, gid) in [
            (None, None),
            (Some("10000"), None),
            (None, Some("10000")),
            (Some(""), Some("10000")),
            (Some("root"), Some("10000")),
            (Some("10000"), Some("wheel")),
            // Zero is the uid being left, never one to switch to — it reaches
            // here only when something exported a placeholder, and honouring
            // it would log a successful "drop" into root.
            (Some("0"), Some("0")),
            (Some("10000"), Some("0")),
            (Some("0"), Some("10000")),
        ] {
            assert!(
                parse_app_identity(uid, gid, "9999").is_none(),
                "uid={uid:?} gid={gid:?} must not produce an identity to switch to",
            );
        }
    }

    #[test]
    fn a_well_formed_identity_carries_its_supplementary_groups() {
        let identity = parse_app_identity(Some("10001"), Some("10001"), "9999,5").expect("should parse");
        assert_eq!(identity.uid, 10001);
        assert_eq!(identity.gid, 10001);
        // `berth` (shared: /context and the daemon sockets) and `tty` (pty
        // allocation for a terminal:* app). Losing these silently is what
        // would make /context unreachable for a reason nothing points at.
        assert_eq!(identity.supplementary_gids, vec![9999, 5]);
    }

    // Garbage in the list is dropped rather than aborting the whole identity:
    // an unparseable supplementary group costs the app one shared resource,
    // while refusing the identity costs it the entire uid boundary.
    #[test]
    fn supplementary_group_parsing_skips_what_it_cannot_use() {
        let identity = parse_app_identity(Some("10000"), Some("10000"), " 9999 ,,0,tty,5").expect("should parse");
        assert_eq!(identity.supplementary_gids, vec![9999, 5], "empty, zero, and non-numeric entries are dropped");
        let identity = parse_app_identity(Some("10000"), Some("10000"), "").expect("should parse");
        assert!(identity.supplementary_gids.is_empty());
    }

    // The drop itself, against the real kernel. It runs in a forked child
    // because setresuid is irreversible and cargo runs every test as a thread
    // of one shared process — dropping uid in-process would break every test
    // that ran after it, in whatever order they happened to run.
    //
    // Needs root to have anywhere to drop *from*, so it skips on the CI
    // runner (non-root) and runs in the Alpine builder image and in any
    // container. That asymmetry is why the parsing above is tested separately
    // rather than only through this.
    #[test]
    fn dropping_to_an_app_uid_is_real_and_irreversible() {
        if unsafe { libc::geteuid() } != 0 {
            eprintln!("skipping: not root, so there is no privilege to drop");
            return;
        }
        let identity = AppIdentity { uid: 10000, gid: 10000, supplementary_gids: vec![] };

        // SAFETY: the child does nothing that requires the parent's locks —
        // it calls syscalls and _exit(2), never the Rust runtime's allocator
        // via a lock a forked thread could have been holding.
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0, "fork failed: {}", std::io::Error::last_os_error());
        if pid == 0 {
            let code = match switch_to_app_identity(&identity) {
                // switch_to_app_identity() verifies both halves itself: that
                // the uid actually changed, and that setuid(0) is refused
                // afterward. A silent no-op is the failure mode that matters
                // — it would hand the app root while the audit line claimed
                // otherwise.
                Ok(()) => 0,
                Err(_) => 1,
            };
            unsafe { libc::_exit(code) };
        }
        let mut status = 0;
        unsafe { libc::waitpid(pid, &mut status, 0) };
        let exited_cleanly = libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0;
        assert!(exited_cleanly, "the uid drop failed or was reversible (wait status {status})");
    }

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

    // The file variant carries no directory-only right. If one crept back in,
    // landlock's PathBeneath compat pass would mask it off on any device-node
    // rule and report a partial downgrade — turning the ruleset
    // PartiallyEnforced and making every production image refuse to boot,
    // which is precisely how REMEDIATION.md 1.15's first attempt failed.
    #[test]
    fn file_write_access_set_contains_no_directory_only_rights() {
        let rights = file_write_access_rights();
        for unexpected in [
            AccessFs::MakeReg,
            AccessFs::MakeDir,
            AccessFs::MakeChar,
            AccessFs::MakeSock,
            AccessFs::MakeFifo,
            AccessFs::MakeBlock,
            AccessFs::MakeSym,
            AccessFs::RemoveDir,
            AccessFs::RemoveFile,
        ] {
            assert!(!rights.contains(unexpected), "{unexpected:?} is directory-only and would downgrade the ruleset on a file rule");
        }
        // ...and still grants what writing a device node actually needs.
        assert!(rights.contains(AccessFs::WriteFile), "a file rule that can't WriteFile grants nothing");
    }

    // The downgrade condition itself, stated as an invariant rather than
    // inferred from a passing boot — this is the one thing that cannot be
    // observed without a kernel that enforces Landlock, so it is worth pinning
    // where it can be.
    //
    // landlock 0.4's PathBeneath compat pass masks a non-directory rule's
    // access down to AccessFs::from_file(ABI) and reports
    // CompatResult::Partial *only if that mask changed something*. So "our
    // file rights survive the mask unchanged" is exactly "no downgrade is
    // reported", and the second assertion records why passing the directory
    // set on a file was the original bug.
    #[test]
    fn file_rights_survive_landlocks_own_file_mask_but_directory_rights_do_not() {
        let file_mask = AccessFs::from_file(ABI::V3);
        assert_eq!(
            file_write_access_rights() & file_mask,
            file_write_access_rights(),
            "the crate's file mask would change our file rights, which reports Partial and downgrades the ruleset",
        );
        assert_ne!(
            write_access_rights() & file_mask,
            write_access_rights(),
            "if this ever becomes equal, the directory set is file-safe and this whole distinction is dead code",
        );
    }

    // The classification, against real inodes rather than a mocked stat: /tmp
    // is a directory, /dev/null is a character device, and getting them the
    // wrong way round is silent in both directions — a file set on a directory
    // quietly fails to grant mkdir, a directory set on a file downgrades the
    // ruleset.
    #[test]
    fn access_rights_are_chosen_by_inode_type() {
        assert_eq!(access_rights_for("/tmp"), write_access_rights(), "/tmp is a directory");
        assert_eq!(access_rights_for("/dev/null"), file_write_access_rights(), "/dev/null is a device node");
        // A symlink is classified by its target, matching what PathFd::new()
        // resolves a moment later. /dev/ptmx -> pts/ptmx in this image.
        if std::fs::symlink_metadata("/dev/ptmx").map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            assert_eq!(access_rights_for("/dev/ptmx"), file_write_access_rights(), "/dev/ptmx resolves to a device node");
        }
        // A path that doesn't exist falls back to the directory set; PathFd is
        // about to fail on it anyway.
        assert_eq!(access_rights_for("/nonexistent-berth-test-path"), write_access_rights());
    }

    // The device paths the policy compiler injects, and the line it must not
    // cross: /dev itself is a tmpfs holding every device node the container
    // has, so the allowance is exact-match only.
    #[test]
    fn write_path_allowlist_permits_only_the_injected_device_paths() {
        for path in ["/dev/null", "/dev/pts", "/dev/ptmx"] {
            assert!(is_allowed_write_path(path, "my-app"), "{path} is injected by generate-capability-policy.ts and must be grantable");
        }
        for path in ["/dev", "/dev/sda", "/dev/mem", "/dev/pts/0", "/dev/null/x", "/dev/kmsg", "/dev/tty"] {
            assert!(!is_allowed_write_path(path, "my-app"), "{path} must not be grantable — the device allowance is exact-match, not a prefix");
        }
    }

    // The socket directory REMEDIATION.md 1.4 moves the app RPC socket into.
    // Scoped to this app's own name rather than allowed as a /run/berth prefix:
    // a prefix would let a policy file grant write access to every sibling's
    // socket directory, which is the exact boundary the move exists to draw.
    #[test]
    fn write_path_allowlist_permits_only_this_apps_own_run_directory() {
        for path in ["/run/berth/my-app", "/run/berth/my-app/rpc.sock"] {
            assert!(is_allowed_write_path(path, "my-app"), "{path} is injected for this app and must be grantable");
        }
        for path in ["/run", "/run/berth", "/run/berth/other-app", "/run/berth/other-app/rpc.sock", "/run/berth/my-app-2", "/run/berthx/my-app"] {
            assert!(!is_allowed_write_path(path, "my-app"), "{path} must not be grantable for app \"my-app\"");
        }
        // An app name that isn't a single path segment must not widen anything;
        // the policy file this comes from is not trusted by this process.
        for name in ["", "..", ".", "/", "a/../b", "berth/../.."] {
            assert!(!is_allowed_write_path("/run/berth", name), "app name {name:?} must not make /run/berth grantable");
            assert!(!is_allowed_write_path("/run/berth/other-app", name), "app name {name:?} must not make a sibling's directory grantable");
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

    // Every path that reaches create_dir_all() as uid 0 goes through this
    // predicate first, so a hole here is a root mkdir of an attacker-chosen
    // path (and, under `berth dev`, on the host).
    #[test]
    fn allowed_write_paths_are_the_four_app_visible_roots_and_paths_beneath_them() {
        for path in ["/workspace", "/workspace/pkg/app", "/context", "/context/agent-runs", "/tmp", "/tmp/my-app", "/app", "/app/.berth"] {
            assert!(is_allowed_write_path(path, "my-app"), "{path} should be an allowed write path");
        }
    }

    #[test]
    fn write_path_allowlist_refuses_the_whole_filesystem_and_paths_outside_it() {
        for path in [
            "/",           // filesystem:write:/ — the entire container
            "/etc",        // ...and the interesting parts of it
            "/etc/passwd",
            "/usr/local/bin",
            "/root",
            "/proc/sys",
            "workspace",       // relative: resolved against whatever cwd happens to be
            "*",               // filesystem:write:* — a literal directory named "*"
            "/workspace/*/src",// a glob that isn't the trailing one the compiler strips
            "/workspace/../etc",
            "/workspace/./x",
            "/workspace//x",
            "/workspace/",     // non-canonical; the canonical form is already allowed
            "/workspacex",     // prefix match must be segment-aware, not string-prefix
            "/tmpfoo",
            "/appdata",
            "",
        ] {
            assert!(!is_allowed_write_path(path, "my-app"), "{path:?} must not be an allowed write path");
        }
    }
}
