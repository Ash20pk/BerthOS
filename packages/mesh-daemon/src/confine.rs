// In-process Landlock confinement for mesh-daemon (BUILD_PLAN M1.2; threat
// model B4).
//
// This daemon cannot be run under agent-init the way context-bus-daemon now
// is: it holds CAP_NET_ADMIN for wg0's whole lifetime (bring-up, every
// `wg syncconf` reconcile tick, route add/del on peer changes), and
// agent-init's capability drop is exactly the thing that would remove it.
// The uid stays 0 for the same reason — netlink interface/route changes are
// CAP_NET_ADMIN-gated, and ambient-capability plumbing to keep it across a
// uid drop is real scope this pass doesn't attempt (named residual in the
// threat model, not an accident).
//
// What CAN be taken away is the filesystem: a compromised mesh-daemon should
// be able to write its WireGuard config, its own key/token state, and its
// control socket — and nothing else. So the daemon applies its own Landlock
// ruleset, write-scoped exactly like agent-init's (AccessFs::from_write,
// V3), before any request is read or any coordinator contacted. Reads stay
// unrestricted (same default an app policy gets) and the network is left
// unhandled: the daemon needs TCP to the coordinator and, in userspace
// mode, boringtun's UDP — and unlike an app it is trusted with "network",
// just not with "the filesystem". A side effect worth naming: a Landlock
// domain also refuses mount(2) and pivot_root(2) outright, even for a
// CAP_SYS_ADMIN-holding root process, so this closes the mount surface for
// this daemon too.
//
// restrict_self() applies to the calling thread and is inherited by threads
// created afterwards — which is why main() calls this BEFORE building the
// tokio runtime. Applying it inside the async runtime would leave every
// already-spawned worker thread unrestricted, silently.
use landlock::{
    AccessFs, BitFlags, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr,
    RulesetStatus, ABI,
};
use std::path::Path;

use crate::config::Config;

/// Everything mesh-daemon (and the wg-quick/wg/ip children it spawns, which
/// inherit the domain) legitimately writes:
///   /etc/wireguard      — wg0.conf, rewritten on every reconcile tick
///   key/token dir       — /run/berth/mesh by default (config.rs)
///   control socket dir  — /tmp by default
///   /run/wireguard      — wg-quick's userspace-mode socket + name-list dir
///   /var/run/wireguard  — the same, on distros where /var/run isn't a
///                         symlink to /run (created explicitly so the rule
///                         binds even before wg-quick would make it)
///   /dev/net/tun        — boringtun opens the tun device in userspace mode
///   /dev/null           — child stdio redirection
///
/// Deliberately NOT all of /run: /run/berth holds every app's socket
/// directory, and a compromised mesh-daemon has no business there. Scoping
/// to /run/wireguard keeps wg-quick working without handing the daemon the
/// rest of /run.
fn write_scoped_dirs(cfg: &Config) -> Vec<String> {
    let mut dirs = vec![
        "/etc/wireguard".to_string(),
        "/run/wireguard".to_string(),
        "/var/run/wireguard".to_string(),
    ];
    for file in [&cfg.key_path, &cfg.token_path, &cfg.control_socket] {
        if let Some(parent) = Path::new(file).parent() {
            let parent = parent.to_string_lossy().to_string();
            if !dirs.contains(&parent) {
                dirs.push(parent);
            }
        }
    }
    dirs
}

const WRITE_SCOPED_DEVICES: [&str; 2] = ["/dev/net/tun", "/dev/null"];

/// Same narrowing agent-init's file_write_access_rights() does, for the same
/// reason: PathBeneath on a non-directory masks the requested rights down to
/// the file set, and under BestEffort any masking downgrades the whole
/// ruleset's reported status to PartiallyEnforced — a false alarm this
/// avoids by asking for exactly what a device node can carry.
fn file_write_access() -> BitFlags<AccessFs> {
    AccessFs::from_write(ABI::V3) & AccessFs::from_file(ABI::V3)
}

pub fn apply(cfg: &Config) -> Result<RulesetStatus, Box<dyn std::error::Error>> {
    let dirs = write_scoped_dirs(cfg);
    // Created before the ruleset binds rules to inodes — a rule can only be
    // added on a path that exists, and this runs as root before any
    // restriction, which is the one moment that mkdir is safe and certain.
    for dir in &dirs {
        let _ = std::fs::create_dir_all(dir);
    }

    let mut ruleset = Ruleset::default().handle_access(AccessFs::from_write(ABI::V3))?.create()?;
    for dir in &dirs {
        match PathFd::new(dir) {
            Ok(fd) => ruleset = ruleset.add_rule(PathBeneath::new(fd, AccessFs::from_write(ABI::V3)))?,
            Err(err) => eprintln!("[mesh-daemon] WARNING: could not open {dir} for a Landlock rule ({err}) — writes there will be refused"),
        }
    }
    for device in WRITE_SCOPED_DEVICES {
        match PathFd::new(device) {
            Ok(fd) => ruleset = ruleset.add_rule(PathBeneath::new(fd, file_write_access()))?,
            // /dev/net/tun only exists when container.ts mapped it (a
            // network:peer:* boot in kernel-absent/userspace mode) — its
            // absence is routine, not an error.
            Err(_) => {}
        }
    }
    Ok(ruleset.restrict_self()?.ruleset)
}

/// `mesh-daemon --confinement-probe <path>`: the milestone test's
/// compromised-daemon simulation. Applies exactly the ruleset apply() gives
/// the real daemon, then attempts to write <path> — something outside the
/// domain — and reports what the kernel said as one JSON line on stdout.
/// Runs standalone in any booted sandbox (no coordinator, no wg0 needed),
/// which is what lets the milestone assert a kernel denial without having to
/// seize the live daemon's process. Exit code 0 whenever the probe itself
/// ran; the caller judges the JSON.
pub fn run_probe(target: Option<&String>) {
    let Some(target) = target else {
        eprintln!("[mesh-daemon] usage: mesh-daemon --confinement-probe <path-to-attempt>");
        std::process::exit(1);
    };
    let cfg = Config::from_env();
    let status = if std::env::var("BERTH_DISABLE_DAEMON_CONFINEMENT").as_deref() == Ok("1") {
        None
    } else {
        match apply(&cfg) {
            Ok(status) => Some(status),
            Err(err) => {
                eprintln!("[mesh-daemon] confinement probe could not apply the ruleset: {err}");
                std::process::exit(1);
            }
        }
    };
    let write_result = std::fs::write(target, b"mesh-confinement-probe\n");
    let denied = write_result.is_err();
    let error = write_result.err().map(|e| e.to_string()).unwrap_or_default();
    // Leave no probe artifact behind on the (negative-control) success path.
    if !denied {
        let _ = std::fs::remove_file(target);
    }
    println!(
        "{{\"source\":\"mesh-daemon\",\"event\":\"confinement_probe\",\"rulesetStatus\":{:?},\"target\":{target:?},\"writeDenied\":{denied},\"error\":{error:?}}}",
        status.map(|s| format!("{s:?}")).unwrap_or_else(|| "Disabled".to_string()),
    );
}
