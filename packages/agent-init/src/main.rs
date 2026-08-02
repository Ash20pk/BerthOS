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
    AccessFs, AccessNet, Access, NetPort, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr, ABI,
};
use serde::Deserialize;

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
}

/// One structured JSON line per boot — a real, greppable audit record of
/// what was granted, since Landlock itself has no deny-notification hook to
/// log individual denials from (see docs/capability-tokens-reference.md).
fn log_audit_event(policy: &CapabilityPolicy, ruleset_status: &str) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    eprintln!(
        "[agent-init] {{\"event\":\"capability_policy_applied\",\"app\":{:?},\"writePaths\":{:?},\"readPaths\":{:?},\"networkPorts\":{:?},\"networkUnrestricted\":{},\"meshPeers\":{:?},\"ruleset\":{:?},\"timestamp\":{}}}",
        policy.app_name, policy.write_paths, policy.read_paths, policy.network_ports, policy.network_unrestricted, policy.mesh_peers, ruleset_status, now
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
        "[agent-init] {{\"event\":\"capabilities_dropped\",\"app\":{app_name:?},\"dropped\":{dropped},\"timestamp\":{now}}}"
    );
}

/// Drops only the two capabilities this repo's `container.ts` ever adds
/// beyond Docker's own default set (SYS_ADMIN for semantic-fs's FUSE mount,
/// NET_ADMIN for mesh-daemon's wg0) — not the whole bounding set. Landlock's
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
/// own default capability set (CAP_DAC_OVERRIDE, CAP_CHOWN, CAP_FOWNER,
/// CAP_NET_RAW, ...) is unaffected by this repo's `CapAdd`; only the two
/// explicitly-added ones need to be revoked before the resident app runs.
/// See docs/mesh-reference.md.
fn drop_all_capabilities() -> Result<(), Box<dyn std::error::Error>> {
    for cap in [Capability::CAP_SYS_ADMIN, Capability::CAP_NET_ADMIN] {
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

    let app_name = match apply_policy(&policy_path) {
        Ok(policy) => {
            eprintln!(
                "[agent-init] restricted \"{}\" — write access allowed only under: {} (declared capabilities: {})",
                policy.app_name,
                policy.write_paths.join(", "),
                policy.declared_capabilities.join(", "),
            );
            policy.app_name
        }
        Err(err) => {
            eprintln!(
                "[agent-init] WARNING: could not apply capability policy from {policy_path} ({err}) — continuing unrestricted."
            );
            "unknown".to_string()
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

    let err = Command::new(&args[0]).args(&args[1..]).exec();
    eprintln!("[agent-init] failed to exec {args:?}: {err}");
    std::process::exit(1);
}

fn apply_policy(policy_path: &str) -> Result<CapabilityPolicy, Box<dyn std::error::Error>> {
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
    let write_access = AccessFs::WriteFile
        | AccessFs::RemoveDir
        | AccessFs::RemoveFile
        | AccessFs::MakeChar
        | AccessFs::MakeDir
        | AccessFs::MakeReg
        | AccessFs::MakeSock
        | AccessFs::MakeFifo
        | AccessFs::MakeBlock
        | AccessFs::MakeSym;
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
    }

    let status = ruleset.restrict_self()?;
    eprintln!(
        "[agent-init] landlock restrict_self() status: ruleset={:?} no_new_privs={:?}",
        status.ruleset, status.no_new_privs
    );
    log_audit_event(&policy, &format!("{:?}", status.ruleset));
    Ok(policy)
}
