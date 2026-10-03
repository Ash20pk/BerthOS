//! The boot plan: everything berth-init decides before it touches the system,
//! as pure functions over the sandbox configuration and the compiled policies.
//! Kept apart from the code that mounts, forks and writes so it can be unit
//! tested anywhere (`cargo test` in the builder VM).
//!
//! Each rule here mirrors one in packages/docker-orchestrator/docker/entrypoint.sh
//! (and, for cgroups, the feat/per-app-cgroups branch of it). Where the VM
//! differs, the comment says why.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// uid/gid of the app at index i is APP_ID_BASE + i (entrypoint.sh's
/// provision_app_identity: index-derived, never name-hashed).
pub const APP_ID_BASE: u32 = 10000;
/// The shared `berth` group (base.Dockerfile: `addgroup -g 9999 berth`).
pub const SHARED_GID: u32 = 9999;
/// context-bus-daemon's own uid (entrypoint.sh's BERTH_DAEMON_BUS_UID).
pub const DAEMON_BUS_UID: u32 = 9001;
/// Alpine's `tty` group, for apps that declare terminal:*.
pub const TTY_GID: u32 = 5;
/// At most this many apps in one sandbox (each gets a vsock port).
pub const MAX_APPS: usize = 64;

/// vsock ports (see docs/design/microvm-guest-init.md, "vsock port plan").
pub const CONTROL_PORT: u32 = 1024;
pub const LOG_PORT: u32 = 1025;
pub const RPC_PORT_BASE: u32 = 5000;
/// The one port where the guest connects out: the host's egress dialer
/// (docs/design/microvm-egress.md). Below RPC_PORT_BASE, so no app index
/// can ever reach it.
pub const EGRESS_PORT: u32 = 1026;

/// The egress broker: its uid/gid (`berth-egress`), its loopback port (the
/// one apps declare as network:connect:8090), and where berth-init serves
/// the socket it reaches the host through.
pub const EGRESS_UID: u32 = 9002;
pub const BROKER_PORT: u16 = 8090;
pub const EGRESS_DIR: &str = "/run/berth/egress";
pub const DIAL_SOCKET: &str = "/run/berth/egress/dial.sock";
pub const EGRESS_POLICY: &str = "/run/berth/egress/policy.json";

/// The GitHub API broker (github-api-broker.cjs, single-app as in a
/// container): its uid (`berth-github`), the loopback port an app declares as
/// network:connect:8092, the directory it writes its CA to (the policy
/// compiler grants the app read access to it), and the root-owned copy of the
/// app's policy it reads its github:* capabilities from.
pub const GITHUB_UID: u32 = 9003;
pub const GITHUB_PORT: u16 = 8092;
pub const GITHUB_DIR: &str = "/run/berth/github";
pub const GITHUB_POLICY: &str = "/run/berth/github/policy.json";
pub const GITHUB_CERT_DIR: &str = "/run/berth/github-api-broker";

/// semantic-fs-daemon's control socket, the SDK's default path (the apps reach
/// it through the berth group), and the FUSE mount it serves.
pub const SEMANTIC_FS_SOCKET: &str = "/tmp/berth-semantic-fs.sock";
pub const CONTEXT_MOUNT: &str = "/context";

/// The embeddings daemon (packages/vmm/guest/embeddings-daemon.mjs): its uid
/// (`berth-embeddings`), and the directory and socket it serves the sandbox's
/// apps on (group berth, 0660). The directory is /run/berth/<its policy's
/// appName>, the one place under /run/berth agent-init lets a policy write.
pub const EMBED_UID: u32 = 9004;
pub const EMBED_DIR: &str = "/run/berth/embeddings-daemon";
pub const EMBED_SOCKET: &str = "/run/berth/embeddings-daemon/embed.sock";

/// Where semantic-fs keeps /context's backing files and its index: on the
/// state disk when there is one, so /context persists across boots as
/// /workspace does; on /run's tmpfs otherwise. Root-only (0700): the apps see
/// these files only through the mount, with the daemon's ownership rules.
pub fn context_store(state_disk: bool) -> &'static str {
    if state_disk {
        "/state/context"
    } else {
        "/run/berth/context"
    }
}

/// semantic-fs-daemon's one JSON line after mounting:
/// {"source":"semantic-fs-daemon","event":"post_mount_caps_narrowed","applied":<bool>,"detail":<string>,...}.
/// Some((applied, detail)) for that line, None for any other.
pub fn caps_narrowed_line(line: &str) -> Option<(bool, String)> {
    let line = line.trim();
    if !line.starts_with('{') || line.len() > 4096 {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("source")?.as_str()? != "semantic-fs-daemon" || v.get("event")?.as_str()? != "post_mount_caps_narrowed" {
        return None;
    }
    Some((v.get("applied")?.as_bool()?, v.get("detail").and_then(Value::as_str).unwrap_or("").chars().take(256).collect()))
}

/// Whether /proc/<pid>/stat says the process is a zombie: the state is the
/// field after the last ')', since the command name may hold anything.
pub fn stat_is_zombie(stat: &str) -> bool {
    stat.rsplit_once(')').is_some_and(|(_, rest)| rest.trim_start().starts_with('Z'))
}

/// Whether /proc/self/mounts has a FUSE filesystem at `mount_point`.
pub fn is_fuse_mount(mounts: &str, mount_point: &str) -> bool {
    mounts.lines().any(|l| {
        let mut f = l.split_whitespace();
        let (_, mp, fs) = (f.next(), f.next(), f.next());
        mp == Some(mount_point) && fs.is_some_and(|t| t == "fuse" || t.starts_with("fuse."))
    })
}

/// Whether a policy declares a /context scope (filesystem:read: or
/// filesystem:write: on /context or under it). Such an app cannot run without
/// semantic-fs, so its absence is a boot failure, not a warning.
pub fn declares_context(policy: &Policy) -> bool {
    policy.declared.iter().any(|c| {
        let scope = c.strip_prefix("filesystem:read:").or_else(|| c.strip_prefix("filesystem:write:"));
        scope.is_some_and(|s| s == CONTEXT_MOUNT || s.starts_with("/context/"))
    })
}

/// The cgroup files berth-init will ever write into an app's cgroup, whatever
/// a policy lists (entrypoint.sh's BERTH_CGROUP_LIMIT_FILES). No memory.high:
/// with no swap, an app past it is throttled indefinitely instead of being
/// OOM-killed at memory.max.
pub const LIMIT_FILES: [&str; 5] = ["cpu.max", "cpu.weight", "memory.max", "memory.swap.max", "pids.max"];
/// What an app gets when its policy has no cgroupLimits (a policy compiled
/// before they existed): the defaults every app gets.
pub const DEFAULT_APP_PIDS: u32 = 1024;
pub const DEFAULT_APP_CPU_WEIGHT: &str = "100";
/// @berthos/manifest-schema's DAEMON_RESERVE.memoryMb and DAEMON_CPU_WEIGHT.
pub const DAEMON_RESERVE_MB: u64 = 256;
pub const DAEMON_CPU_WEIGHT: &str = "1000";
/// Smallest apps' budget worth keeping a reserve for (entrypoint.sh: 32 MiB).
pub const MIN_APPS_BUDGET_BYTES: u64 = 32 * 1024 * 1024;

/// One app as the host described it: a virtio-fs share tag. Its name comes
/// from its compiled policy, as in entrypoint.sh's single-app path, so the
/// name agent-init logs, the RPC socket and the cgroup can never disagree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppSpec {
    pub index: usize,
    pub tag: String,
    /// Where the share is mounted in the guest, and the app's working directory.
    pub dir: String,
    pub uid: u32,
    pub rpc_port: u32,
}

fn valid_tag(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 32
        && t.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !t.starts_with('-')
}

/// `BERTH_VM_APPS`: comma-separated share tags, in the host's order (which
/// fixes each app's uid and RPC port). Unset or empty means the single-app
/// layout the spike used: one share tagged `app`, mounted at /app. With more
/// than one app each is mounted at /app/<tag>.
pub fn parse_apps(var: Option<&str>) -> Result<Vec<AppSpec>, String> {
    let raw = var.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("app");
    let tags: Vec<&str> = raw.split(',').map(str::trim).collect();
    if tags.len() > MAX_APPS {
        return Err(format!("BERTH_VM_APPS lists {} apps; at most {MAX_APPS}", tags.len()));
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(tags.len());
    for (index, tag) in tags.iter().enumerate() {
        if !valid_tag(tag) {
            return Err(format!("BERTH_VM_APPS entry {tag:?} is not a share tag ([a-z0-9-], 1-32 chars)"));
        }
        if !seen.insert(*tag) {
            return Err(format!("BERTH_VM_APPS lists {tag:?} twice"));
        }
        let dir = if tags.len() == 1 { "/app".to_string() } else { format!("/app/{tag}") };
        out.push(AppSpec {
            index,
            tag: tag.to_string(),
            dir,
            uid: APP_ID_BASE + index as u32,
            rpc_port: RPC_PORT_BASE + index as u32,
        });
    }
    Ok(out)
}

/// The parts of a compiled capability policy berth-init reads. agent-init
/// reads the rest.
#[derive(Debug, Clone, PartialEq)]
pub struct Policy {
    pub app_name: String,
    pub write_paths: Vec<Value>,
    pub declared: Vec<String>,
    /// Ordered as the compiler wrote them (serde_json keeps insertion order
    /// only with a feature; we keep a Vec of pairs instead).
    pub cgroup_limits: Option<Vec<(String, Value)>>,
}

/// The manifest schema's app-name rule (lower kebab). Checked again here
/// because the name becomes a path component under /run, /tmp and /sys.
pub fn valid_app_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 64 && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn parse_policy(json: &str) -> Result<Policy, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("policy is not JSON: {e}"))?;
    let app_name = v.get("appName").and_then(Value::as_str).ok_or("policy has no appName")?.to_string();
    if !valid_app_name(&app_name) {
        return Err(format!("policy appName {app_name:?} is not a valid app name"));
    }
    let write_paths = v.get("writePaths").and_then(Value::as_array).cloned().unwrap_or_default();
    let declared = v
        .get("declaredCapabilities")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default();
    let cgroup_limits = v.get("cgroupLimits").and_then(Value::as_object).map(|o| {
        // serde_json's Map without preserve_order is sorted by key, which is
        // a stable order; the kernel does not care which limit lands first.
        o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    });
    Ok(Policy { app_name, write_paths, declared, cgroup_limits })
}

/// The manifest schema's ALLOWED_FILESYSTEM_SCOPE_PREFIXES check as
/// entrypoint.sh's precreate_declared_paths applies it: canonical, no globs,
/// nothing inside a node_modules. This process does the mkdir and chown as
/// root, so it does not take the policy file's word for it.
pub fn allowed_precreate(p: &str) -> bool {
    if p.contains('\0') || p.contains('*') {
        return false;
    }
    let prefixed = ["/workspace", "/context", "/tmp", "/app"].iter().any(|pre| p == *pre || p.starts_with(&format!("{pre}/")));
    prefixed && !p[1..].split('/').any(|s| s.is_empty() || s == "." || s == ".." || s == "node_modules")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Owner {
    /// Declared writable by exactly one app: that app's uid, 0755.
    App(u32),
    /// Declared writable by several: root:berth, 2775 (setgid).
    Shared,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Precreate {
    pub path: String,
    pub owner: Owner,
}

/// Which declared write paths to create, and who owns each.
///
/// `exists` says whether a path is already there. Anything that exists is
/// left alone, as in entrypoint.sh, with one VM-specific exception:
/// `fresh_mounts`, the tmpfs mounts berth-init itself just made (/workspace,
/// and /context only in an image without semantic-fs, whose mount it owns). In the image those directories do not exist until this pass
/// creates them; in the VM a mount point has to, so their root is treated as
/// new and gets the ownership the declarations call for.
pub fn precreate_plan(
    apps: &[(u32, &Policy)],
    exists: &dyn Fn(&str) -> bool,
    fresh_mounts: &[&str],
) -> (Vec<Precreate>, Vec<String>) {
    let mut owners: BTreeMap<String, BTreeSet<u32>> = BTreeMap::new();
    let mut warnings = Vec::new();
    for (uid, policy) in apps {
        for p in &policy.write_paths {
            match p.as_str() {
                Some(s) if allowed_precreate(s) => {
                    owners.entry(s.to_string()).or_default().insert(*uid);
                }
                Some(s) if exists(s) => {}
                _ => warnings.push(format!(
                    "not creating {p} for {} — outside /workspace, /context, /tmp, /app, or inside a node_modules",
                    policy.app_name
                )),
            }
        }
    }
    let plan = owners
        .into_iter()
        .filter(|(path, _)| !exists(path) || fresh_mounts.contains(&path.as_str()))
        .map(|(path, uids)| {
            let owner = if uids.len() == 1 { Owner::App(*uids.iter().next().unwrap()) } else { Owner::Shared };
            Precreate { path, owner }
        })
        .collect();
    (plan, warnings)
}

/// What to write into one app's cgroup, and what was refused before the
/// kernel ever saw it. Mirrors place_app_in_cgroup: only LIMIT_FILES, only
/// values matching ^[0-9a-z ]+$, and the defaults when the policy has none.
pub fn app_limits(policy: &Policy, default_pids: u32) -> (Vec<(String, String)>, Vec<String>) {
    let entries: Vec<(String, Value)> = match &policy.cgroup_limits {
        Some(l) => l.clone(),
        None => vec![
            ("cpu.weight".into(), Value::String(DEFAULT_APP_CPU_WEIGHT.into())),
            ("pids.max".into(), Value::String(default_pids.to_string())),
        ],
    };
    let mut write = Vec::new();
    let mut skipped = Vec::new();
    for (file, value) in entries {
        let Some(v) = value.as_str() else {
            skipped.push(format!("{file} (value is not a string)"));
            continue;
        };
        if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || b == b' ') {
            skipped.push(format!("{file} (value {v:?} rejected)"));
            continue;
        }
        if !LIMIT_FILES.contains(&file.as_str()) {
            skipped.push(format!("{file} (not a limit berth-init writes)"));
            continue;
        }
        write.push((file, v.to_string()));
    }
    (write, skipped)
}

/// The apps' parent cgroup's memory.max: the sandbox's memory less the daemon
/// reserve. In the VM the sandbox's memory is the guest's MemTotal. A sandbox
/// too small to hold the reserve and 32 MiB of apps keeps no reserve at all.
pub fn apps_memory_max(total_bytes: u64, reserve_mb: u64) -> Option<u64> {
    let reserve = reserve_mb * 1024 * 1024;
    (total_bytes > reserve + MIN_APPS_BUDGET_BYTES).then(|| total_bytes - reserve)
}

/// /proc/meminfo's `<key>:  N kB` in bytes.
pub fn meminfo_bytes(meminfo: &str, key: &str) -> Option<u64> {
    meminfo.lines().find_map(|l| {
        let rest = l.strip_prefix(key)?.strip_prefix(':')?;
        let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
        Some(kb * 1024)
    })
}

/// Whether an app declares host-scoped egress: the capabilities that make
/// entrypoint.sh start the egress broker (run-lifecycle.ts's needsEgressBroker).
pub fn declares_egress(policy: &Policy) -> bool {
    policy.declared.iter().any(|c| c.starts_with("network:host:") || c.starts_with("browser:navigate:"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EgressPlan {
    /// No app declares egress: no broker, no relay.
    None,
    /// One app does: the broker enforces that app's declared patterns. The
    /// value is the app's position in the list given.
    Broker(usize),
    /// More than one does. The broker port is one resource for the whole
    /// sandbox and its pattern list is one app's, so this is refused, as the
    /// CLI's assertAtMostOneEgressBrokerApp refuses it for a container.
    Refused(String),
}

pub fn egress_plan(apps: &[&Policy]) -> EgressPlan {
    let wanting: Vec<usize> = (0..apps.len()).filter(|i| declares_egress(apps[*i])).collect();
    match wanting.as_slice() {
        [] => EgressPlan::None,
        [one] => EgressPlan::Broker(*one),
        many => EgressPlan::Refused(format!(
            "more than one app declares network:host:/browser:navigate: ({}); one egress broker serves one app's patterns, so none is started",
            many.iter().map(|i| apps[*i].app_name.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

pub fn declares_github(policy: &Policy) -> bool {
    policy.declared.iter().any(|c| c.starts_with("github:"))
}

/// Which app the GitHub API broker serves. One, as entrypoint.sh starts it for
/// a single-app container only: its CA is trusted process-wide by that app,
/// and its policy is that app's.
pub fn github_plan(apps: &[&Policy]) -> EgressPlan {
    let wanting: Vec<usize> = (0..apps.len()).filter(|i| declares_github(apps[*i])).collect();
    match wanting.as_slice() {
        [] => EgressPlan::None,
        [one] => EgressPlan::Broker(*one),
        many => EgressPlan::Refused(format!(
            "more than one app declares github:* ({}); the GitHub API broker serves one app, so none is started",
            many.iter().map(|i| apps[*i].app_name.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// The app's own gid, the shared berth group, and tty for terminal:* apps
/// (entrypoint.sh's addgroup calls, read back by export_app_identity).
pub fn supplementary_gids(uid: u32, policy: &Policy) -> Vec<u32> {
    let mut g = vec![uid, SHARED_GID];
    if policy.declared.iter().any(|c| c.starts_with("terminal:")) {
        g.push(TTY_GID);
    }
    g
}

/// One `app:invoke:<target>` grant: /run/berth/<target>/peers/<caller>,
/// owned by the target, group-owned by the caller, mode 2710.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvokeGrant {
    pub caller: String,
    pub target: String,
    pub dir: String,
    pub target_uid: u32,
    pub caller_gid: u32,
}

/// apps: (name, uid, policy). Targets not in this sandbox are warned about
/// and skipped, as grant_invoke_access does.
pub fn invoke_grants(apps: &[(String, u32, &Policy)]) -> (Vec<InvokeGrant>, Vec<String>) {
    let by_name: BTreeMap<&str, u32> = apps.iter().map(|(n, u, _)| (n.as_str(), *u)).collect();
    let mut grants = Vec::new();
    let mut warnings = Vec::new();
    for (caller, caller_uid, policy) in apps {
        for cap in &policy.declared {
            let Some(target) = cap.strip_prefix("app:invoke:") else { continue };
            match by_name.get(target) {
                Some(t) if valid_app_name(target) => grants.push(InvokeGrant {
                    caller: caller.clone(),
                    target: target.to_string(),
                    dir: format!("/run/berth/{target}/peers/{caller}"),
                    target_uid: *t,
                    caller_gid: *caller_uid,
                }),
                _ => warnings.push(format!("{caller} declares app:invoke:{target}, but no app named {target} is in this sandbox — ignoring")),
            }
        }
    }
    (grants, warnings)
}

/// /etc/passwd and /etc/group for the identities berth-init creates, merged
/// into the image's own files. The result goes on a tmpfs copy that is
/// bind-mounted over the originals: the root filesystem is read only, so
/// adduser cannot run. Users join `berth` (9999) and, for terminal:* apps,
/// `tty` (5); if the image already has a group with that gid its member list
/// is extended, otherwise the group is added.
pub fn identity_files(passwd: &str, group: &str, apps: &[(String, u32, Vec<u32>)], with_bus: bool, with_egress: bool, with_github: bool, with_embeddings: bool) -> (String, String) {
    let mut users: Vec<(String, u32, String)> = Vec::new();
    if with_bus {
        users.push(("berth-context-bus".into(), DAEMON_BUS_UID, "berth daemon".into()));
    }
    for (name, uid, _) in apps {
        users.push((format!("berth-{name}"), *uid, format!("berth app {name}")));
    }
    // In `berth` too: it gives its socket to the group, so every app may connect.
    if with_embeddings {
        users.push(("berth-embeddings".into(), EMBED_UID, "berth embeddings daemon".into()));
    }
    let mut extra: BTreeMap<u32, Vec<String>> = BTreeMap::new();
    extra.insert(SHARED_GID, users.iter().map(|u| u.0.clone()).collect());
    // Not in `berth`: the broker has no business in the apps' shared
    // directories (root:berth 2775).
    if with_egress {
        users.push(("berth-egress".into(), EGRESS_UID, "berth egress broker".into()));
    }
    if with_github {
        users.push(("berth-github".into(), GITHUB_UID, "berth GitHub API broker".into()));
    }
    let tty: Vec<String> = apps.iter().filter(|(_, _, g)| g.contains(&TTY_GID)).map(|(n, _, _)| format!("berth-{n}")).collect();
    if !tty.is_empty() {
        extra.insert(TTY_GID, tty);
    }
    let names: BTreeSet<&str> = users.iter().map(|u| u.0.as_str()).collect();
    // The ids are berth-init's to assign: an image entry that already holds
    // one of them (the spike's rootfs has `notes:x:10000`) would win a
    // getpwuid() lookup, and context-bus-daemon names its peers that way.
    let ids: BTreeSet<String> = users.iter().map(|u| u.1.to_string()).collect();
    let taken = |line: &str| {
        let f: Vec<&str> = line.split(':').collect();
        names.contains(f[0]) || f.get(2).is_some_and(|id| ids.contains(*id))
    };

    let mut p = String::new();
    for line in passwd.lines().filter(|l| !taken(l)) {
        p.push_str(line);
        p.push('\n');
    }
    for (user, uid, gecos) in &users {
        p.push_str(&format!("{user}:x:{uid}:{uid}:{gecos}:/nonexistent:/sbin/nologin\n"));
    }

    let mut g = String::new();
    let mut seen = BTreeSet::new();
    for line in group.lines() {
        let f: Vec<&str> = line.split(':').collect();
        if f.len() == 4 && taken(line) {
            continue;
        }
        match f.get(2).and_then(|gid| gid.parse::<u32>().ok()).filter(|gid| f.len() == 4 && extra.contains_key(gid)) {
            Some(gid) => {
                seen.insert(gid);
                let mut members: Vec<String> = f[3].split(',').filter(|m| !m.is_empty()).map(String::from).collect();
                members.extend(extra[&gid].iter().cloned());
                g.push_str(&format!("{}:{}:{}:{}\n", f[0], f[1], f[2], members.join(",")));
            }
            None => {
                g.push_str(line);
                g.push('\n');
            }
        }
    }
    for (user, uid, _) in &users {
        g.push_str(&format!("{user}:x:{uid}:\n"));
    }
    for (gid, members) in &extra {
        if !seen.contains(gid) {
            let name = if *gid == SHARED_GID { "berth" } else { "tty" };
            g.push_str(&format!("{name}:x:{gid}:{}\n", members.join(",")));
        }
    }
    (p, g)
}

/// Strict modes, spelled like BERTH_REQUIRE_ENFORCEMENT. In the VM per-app
/// cgroups are required unless the host says otherwise: berth-init owns the
/// cgroup root, so there is no host configuration that could excuse their
/// absence the way a Docker host without nsdelegate can.
pub fn flag(value: Option<&str>, default: bool) -> bool {
    match value {
        Some("1") | Some("true") => true,
        Some("0") | Some("false") => false,
        _ => default,
    }
}

/// How the relay reaches an app's RPC server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RpcMode {
    /// The SDK's per-app Unix socket (/run/berth/<app>/rpc.sock). The app's
    /// stdout and stderr are then logs only. The default.
    Socket,
    /// The app's stdin/stdout, multiplexed by request id. stdout lines that
    /// are not an answer to a pending request are logs.
    Stdio,
}

pub fn rpc_mode(v: Option<&str>) -> Result<RpcMode, String> {
    match v.unwrap_or("socket") {
        "socket" | "" => Ok(RpcMode::Socket),
        "stdio" => Ok(RpcMode::Stdio),
        other => Err(format!("BERTH_VM_RPC={other:?}: expected socket or stdio")),
    }
}

/// The language an app's code is in (berth.yml `runtime:`), as the CLI's
/// manifest loader decided it and wrote it into the share's `.berth-runtime`,
/// as the container image records it in /etc/berth/runtime/<app>. A share with
/// no such file is node, which is every share made before Python ran in a VM.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Runtime {
    Node,
    Python,
}

pub const RUNTIME_FILE: &str = ".berth-runtime";

pub fn parse_runtime(file: Option<&str>) -> Result<Runtime, String> {
    match file.map(str::trim) {
        None | Some("node") => Ok(Runtime::Node),
        Some("python") => Ok(Runtime::Python),
        Some(other) => Err(format!("{RUNTIME_FILE} says {:?}; expected node or python", other.chars().take(32).collect::<String>())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn one_github_broker_app() {
        let gh = policy("github-assistant", &[], &["github:read:repos", "network:connect:8092"], None);
        let notes = policy("notes", &[], &["filesystem:write:/workspace"], None);
        assert_eq!(github_plan(&[&notes]), EgressPlan::None);
        assert_eq!(github_plan(&[&notes, &gh]), EgressPlan::Broker(1));
        let gh2 = policy("other", &[], &["github:write:issues"], None);
        assert!(matches!(github_plan(&[&gh, &gh2]), EgressPlan::Refused(m) if m.contains("github-assistant, other")));
        let (p, _) = identity_files("root:x:0:0::/:/bin/sh\n", "root:x:0:root\n", &[], false, false, true, false);
        assert!(p.contains("berth-github:x:9003:9003:"));
    }

    #[test]
    fn embeddings_daemon_identity() {
        let (p, g) = identity_files("root:x:0:0::/:/bin/sh\n", "root:x:0:root\n", &[], false, false, false, true);
        assert!(p.contains("berth-embeddings:x:9004:9004:"));
        assert!(g.lines().any(|l| l.starts_with("berth:x:9999:") && l.contains("berth-embeddings")), "{g}");
    }

    #[test]
    fn context_declarations() {
        assert!(declares_context(&policy("filesystem", &[], &["filesystem:read:/context", "filesystem:write:/context"], None)));
        assert!(declares_context(&policy("a", &[], &["filesystem:read:/context/notes"], None)));
        assert!(!declares_context(&policy("notes", &[], &["filesystem:write:/workspace"], None)));
        assert!(!declares_context(&policy("b", &[], &["filesystem:read:/contextual"], None)));
        assert!(!declares_context(&policy("c", &[], &["network:host:context"], None)));
        assert_eq!(context_store(true), "/state/context");
        assert_eq!(context_store(false), "/run/berth/context");
    }

    #[test]
    fn semantic_fs_readiness() {
        let ok = r#"{"source":"semantic-fs-daemon","event":"post_mount_caps_narrowed","bootId":"b","applied":true,"detail":"","timestamp":1}"#;
        assert_eq!(caps_narrowed_line(ok), Some((true, String::new())));
        let failed = r#"{"source":"semantic-fs-daemon","event":"post_mount_caps_narrowed","applied":false,"detail":"EPERM"}"#;
        assert_eq!(caps_narrowed_line(failed), Some((false, "EPERM".into())));
        assert_eq!(caps_narrowed_line("2026/10/03 [semantic-fs] mounted at /context"), None);
        assert_eq!(caps_narrowed_line(r#"{"source":"agent-init","event":"post_mount_caps_narrowed","applied":true}"#), None);
        assert_eq!(caps_narrowed_line(r#"{"source":"semantic-fs-daemon","event":"post_mount_caps_narrowed","applied":"yes"}"#), None);

        assert!(stat_is_zombie("42 (semantic-fs-d) Z 1 42 42 0"));
        assert!(!stat_is_zombie("42 (a) Z) S 1 42"));
        assert!(!stat_is_zombie("42 (semantic-fs-d) S 1 42 42 0"));

        let mounts = "tmpfs /tmp tmpfs rw 0 0\nberth-semantic-fs /context fuse.berthctx rw,nosuid,nodev,user_id=0,group_id=0,default_permissions,allow_other 0 0\n";
        assert!(is_fuse_mount(mounts, "/context"));
        assert!(!is_fuse_mount("tmpfs /context tmpfs rw 0 0\n", "/context"));
        assert!(!is_fuse_mount(mounts, "/workspace"));
    }

    #[test]
    fn runtime_from_the_share() {
        assert_eq!(parse_runtime(None), Ok(Runtime::Node));
        assert_eq!(parse_runtime(Some("python\n")), Ok(Runtime::Python));
        assert_eq!(parse_runtime(Some("node")), Ok(Runtime::Node));
        assert!(parse_runtime(Some("ruby")).unwrap_err().contains("expected node or python"));
    }

    fn policy(name: &str, writes: &[&str], declared: &[&str], limits: Option<Value>) -> Policy {
        let mut v = json!({ "appName": name, "writePaths": writes, "declaredCapabilities": declared });
        if let Some(l) = limits {
            v["cgroupLimits"] = l;
        }
        parse_policy(&v.to_string()).unwrap()
    }

    #[test]
    fn single_app_default_layout() {
        let apps = parse_apps(None).unwrap();
        assert_eq!(apps, vec![AppSpec { index: 0, tag: "app".into(), dir: "/app".into(), uid: 10000, rpc_port: 5000 }]);
        assert_eq!(parse_apps(Some("  ")).unwrap()[0].dir, "/app");
        assert_eq!(parse_apps(Some("notes")).unwrap()[0].dir, "/app");
    }

    #[test]
    fn multi_app_layout_is_index_derived() {
        let apps = parse_apps(Some("notes, filesystem")).unwrap();
        assert_eq!(apps[0].dir, "/app/notes");
        assert_eq!(apps[1].dir, "/app/filesystem");
        assert_eq!((apps[1].uid, apps[1].rpc_port), (10001, 5001));
    }

    #[test]
    fn bad_app_lists_are_refused() {
        assert!(parse_apps(Some("a,a")).is_err());
        assert!(parse_apps(Some("../etc")).is_err());
        assert!(parse_apps(Some("Notes")).is_err());
        assert!(parse_apps(Some("a,,b")).is_err());
        assert!(parse_apps(Some("-x")).is_err());
        let many = (0..65).map(|i| format!("a{i}")).collect::<Vec<_>>().join(",");
        assert!(parse_apps(Some(&many)).is_err());
    }

    #[test]
    fn policy_needs_a_safe_name() {
        assert!(parse_policy(r#"{"appName":"notes"}"#).is_ok());
        assert!(parse_policy(r#"{"appName":"../x"}"#).is_err());
        assert!(parse_policy(r#"{"appName":"a/b"}"#).is_err());
        assert!(parse_policy(r#"{}"#).is_err());
        assert!(parse_policy("not json").is_err());
    }

    #[test]
    fn precreate_allowlist_mirrors_entrypoint() {
        for ok in ["/workspace", "/workspace/a/b", "/context", "/tmp/x", "/app/data"] {
            assert!(allowed_precreate(ok), "{ok}");
        }
        for bad in [
            "/etc", "/workspacex", "/workspace/", "/workspace//a", "/workspace/./a", "/workspace/../etc",
            "/workspace/node_modules/x", "/tmp/*", "/run/berth/notes", "/dev/null", "relative", "/app/a\0b",
        ] {
            assert!(!allowed_precreate(bad), "{bad:?}");
        }
    }

    #[test]
    fn precreate_owners() {
        let notes = policy("notes", &["/dev/null", "/workspace", "/workspace/notes", "/run/berth/notes"], &[], None);
        let fs = policy("filesystem", &["/workspace", "/context", "/etc/evil"], &[], None);
        let exists = |p: &str| matches!(p, "/dev/null" | "/run/berth/notes" | "/workspace" | "/context" | "/tmp");
        let (plan, warnings) = precreate_plan(&[(10000, &notes), (10001, &fs)], &exists, &["/workspace", "/context"]);
        assert_eq!(
            plan,
            vec![
                Precreate { path: "/context".into(), owner: Owner::App(10001) },
                Precreate { path: "/workspace".into(), owner: Owner::Shared },
                Precreate { path: "/workspace/notes".into(), owner: Owner::App(10000) },
            ]
        );
        // /dev/null and /run/berth/notes exist and are silently left alone;
        // /etc/evil does not exist and is outside the allowlist.
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("/etc/evil"));
    }

    #[test]
    fn precreate_leaves_existing_paths_alone() {
        let a = policy("a", &["/tmp"], &[], None);
        let (plan, _) = precreate_plan(&[(10000, &a)], &|p| p == "/tmp", &["/workspace"]);
        assert!(plan.is_empty());
    }

    #[test]
    fn limits_default_when_policy_has_none() {
        let p = policy("a", &[], &[], None);
        let (w, s) = app_limits(&p, 1024);
        assert_eq!(w, vec![("cpu.weight".to_string(), "100".to_string()), ("pids.max".to_string(), "1024".to_string())]);
        assert!(s.is_empty());
    }

    #[test]
    fn limits_filter_files_and_values() {
        let p = policy(
            "a",
            &[],
            &[],
            Some(json!({
                "cpu.max": "50000 100000",
                "cpu.weight": "100",
                "memory.max": "134217728",
                "memory.swap.max": "0",
                "pids.max": "128",
                "memory.high": "1",
                "cgroup.procs": "1",
                "cgroup.subtree_control": "+cpu",
                "pids.max\n": "1",
            })),
        );
        let (w, s) = app_limits(&p, 1024);
        let files: Vec<&str> = w.iter().map(|(f, _)| f.as_str()).collect();
        assert_eq!(files, vec!["cpu.max", "cpu.weight", "memory.max", "memory.swap.max", "pids.max"]);
        assert_eq!(s.len(), 4, "{s:?}");
        // A value that would smuggle a second write is refused before the kernel sees it.
        let p = policy("a", &[], &[], Some(json!({ "pids.max": "10\n+cpu", "cpu.max": 5, "cpu.weight": "" })));
        let (w, s) = app_limits(&p, 1024);
        assert!(w.is_empty());
        assert_eq!(s.len(), 3);
    }

    #[test]
    fn apps_budget_keeps_the_daemon_reserve() {
        let mib = 1024 * 1024;
        assert_eq!(apps_memory_max(1024 * mib, 256), Some(768 * mib));
        // 256 + 32 MiB is the floor; at or below it no reserve is kept.
        assert_eq!(apps_memory_max(288 * mib, 256), None);
        assert_eq!(apps_memory_max(289 * mib, 256), Some(33 * mib));
    }

    #[test]
    fn meminfo_parsing() {
        let m = "MemTotal:         491520 kB\nMemFree:  1 kB\nSwapTotal:             0 kB\n";
        assert_eq!(meminfo_bytes(m, "MemTotal"), Some(491520 * 1024));
        assert_eq!(meminfo_bytes(m, "SwapTotal"), Some(0));
        assert_eq!(meminfo_bytes(m, "Mem"), None);
    }

    #[test]
    fn groups_and_identities() {
        let term = policy("t", &[], &["terminal:pty"], None);
        let plain = policy("p", &[], &["filesystem:write:/workspace"], None);
        assert_eq!(supplementary_gids(10000, &term), vec![10000, 9999, 5]);
        assert_eq!(supplementary_gids(10001, &plain), vec![10001, 9999]);
        let apps = [("t".to_string(), 10000, vec![10000, 9999, 5]), ("p".to_string(), 10001, vec![10001, 9999])];
        let (passwd, group) = identity_files(
            "root:x:0:0:root:/root:/bin/sh\nberth-t:x:1:1:stale:/:/bin/sh\nnotes:x:10001:10001:old:/:/bin/sh\n",
            "root:x:0:root\ntty:x:5:\nberth-p:x:7:\nnotes:x:10001:\n",
            &apps,
            true,
            false,
            false,
            false,
        );
        assert_eq!(
            passwd.lines().collect::<Vec<_>>(),
            vec![
                "root:x:0:0:root:/root:/bin/sh",
                "berth-context-bus:x:9001:9001:berth daemon:/nonexistent:/sbin/nologin",
                "berth-t:x:10000:10000:berth app t:/nonexistent:/sbin/nologin",
                "berth-p:x:10001:10001:berth app p:/nonexistent:/sbin/nologin",
            ]
        );
        assert_eq!(
            group.lines().collect::<Vec<_>>(),
            vec![
                "root:x:0:root",
                "tty:x:5:berth-t",
                "berth-context-bus:x:9001:",
                "berth-t:x:10000:",
                "berth-p:x:10001:",
                "berth:x:9999:berth-context-bus,berth-t,berth-p",
            ]
        );
    }

    #[test]
    fn egress_identity_is_outside_the_shared_group() {
        let apps = [("a".to_string(), 10000, vec![10000, 9999])];
        let (passwd, group) = identity_files("root:x:0:0::/:/bin/sh\n", "root:x:0:root\n", &apps, false, true, false, false);
        assert!(passwd.lines().any(|l| l == "berth-egress:x:9002:9002:berth egress broker:/nonexistent:/sbin/nologin"));
        assert!(group.lines().any(|l| l == "berth-egress:x:9002:"));
        assert!(group.lines().any(|l| l == "berth:x:9999:berth-a"), "{group}");
    }

    #[test]
    fn one_egress_app_at_most() {
        let fetch = policy("fetch", &[], &["network:host:example.com", "network:connect:8090"], None);
        let browser = policy("browser", &[], &["browser:navigate:*"], None);
        let plain = policy("plain", &[], &["network:connect:443", "filesystem:write:/workspace"], None);
        assert!(declares_egress(&fetch) && declares_egress(&browser) && !declares_egress(&plain));
        assert_eq!(egress_plan(&[&plain]), EgressPlan::None);
        assert_eq!(egress_plan(&[&plain, &fetch]), EgressPlan::Broker(1));
        match egress_plan(&[&fetch, &plain, &browser]) {
            EgressPlan::Refused(why) => assert!(why.contains("fetch, browser"), "{why}"),
            other => panic!("{other:?}"),
        }
        assert!(EGRESS_PORT < RPC_PORT_BASE && EGRESS_PORT != CONTROL_PORT && EGRESS_PORT != LOG_PORT);
    }

    #[test]
    fn invoke_grants_need_a_target() {
        let caller = policy("agent", &[], &["app:invoke:notes", "app:invoke:missing"], None);
        let notes = policy("notes", &[], &[], None);
        let (g, w) = invoke_grants(&[("agent".into(), 10000, &caller), ("notes".into(), 10001, &notes)]);
        assert_eq!(
            g,
            vec![InvokeGrant {
                caller: "agent".into(),
                target: "notes".into(),
                dir: "/run/berth/notes/peers/agent".into(),
                target_uid: 10001,
                caller_gid: 10000
            }]
        );
        assert_eq!(w.len(), 1);
    }

    #[test]
    fn flags_and_modes() {
        assert!(flag(None, true));
        assert!(!flag(Some("0"), true));
        assert!(flag(Some("true"), false));
        assert!(flag(Some("junk"), true));
        assert_eq!(rpc_mode(None).unwrap(), RpcMode::Socket);
        assert_eq!(rpc_mode(Some("stdio")).unwrap(), RpcMode::Stdio);
        assert!(rpc_mode(Some("tcp")).is_err());
    }
}
