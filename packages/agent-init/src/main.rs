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

use landlock::{AccessFs, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr, ABI};
use serde::Deserialize;

#[derive(Deserialize)]
struct CapabilityPolicy {
    #[serde(rename = "appName")]
    app_name: String,
    #[serde(rename = "declaredCapabilities")]
    declared_capabilities: Vec<String>,
    #[serde(rename = "writePaths")]
    write_paths: Vec<String>,
}

fn main() {
    let policy_path =
        env::var("BERTH_CAPABILITY_POLICY").unwrap_or_else(|_| ".berth/capability-policy.json".to_string());

    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("[agent-init] usage: agent-init <command> [args...]");
        std::process::exit(1);
    }

    match apply_policy(&policy_path) {
        Ok(policy) => {
            eprintln!(
                "[agent-init] restricted \"{}\" — write access allowed only under: {} (declared capabilities: {})",
                policy.app_name,
                policy.write_paths.join(", "),
                policy.declared_capabilities.join(", "),
            );
        }
        Err(err) => {
            eprintln!(
                "[agent-init] WARNING: could not apply capability policy from {policy_path} ({err}) — continuing unrestricted."
            );
        }
    }

    let err = Command::new(&args[0]).args(&args[1..]).exec();
    eprintln!("[agent-init] failed to exec {args:?}: {err}");
    std::process::exit(1);
}

fn apply_policy(policy_path: &str) -> Result<CapabilityPolicy, Box<dyn std::error::Error>> {
    let raw = std::fs::read_to_string(policy_path)?;
    let policy: CapabilityPolicy = serde_json::from_str(&raw)?;

    // Deliberately WRITE-ish access rights only — read/execute stay
    // unrestricted. Node.js (and anything else the base image ships) needs
    // broad read access to function at all, and enumerating every path it
    // legitimately needs to read is fragile. Restricting writes is both the
    // higher-value threat-model boundary (tampering, exfiltration-by-write,
    // planting files) and the one we can scope correctly today. See
    // docs/capability-tokens-reference.md.
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

    let abi = ABI::V3;
    let mut ruleset = Ruleset::default().handle_access(write_access)?.create()?;

    for path in &policy.write_paths {
        match PathFd::new(path) {
            Ok(fd) => {
                ruleset = ruleset.add_rule(PathBeneath::new(fd, write_access))?;
            }
            Err(err) => {
                eprintln!("[agent-init] WARNING: couldn't open \"{path}\" to grant write access ({err}), skipping");
            }
        }
    }

    let _ = abi; // reserved: bumping ABI version later should only require raising this constant
    let status = ruleset.restrict_self()?;
    eprintln!(
        "[agent-init] landlock restrict_self() status: ruleset={:?} no_new_privs={:?}",
        status.ruleset, status.no_new_privs
    );
    Ok(policy)
}
