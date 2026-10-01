//! berth-init: PID 1 of a Berth microVM guest.
//!
//! It does, in one static binary, what docker/entrypoint.sh plus tini do in
//! the container, and what the spike's berth-init.sh plus socat did in the VM:
//!
//!  1. PID 1 duties: mount /proc, /sys, /dev (+pts, shm), securityfs, cgroup2
//!     and the tmpfs mounts; reap every zombie; shut down cleanly (stop the
//!     apps, sync, unmount, power off) when the host asks or every app exits.
//!  2. The boot: compile each app's berth.yml into its capability policy (the
//!     image's bundled node tool, as root), create the app identities and
//!     directories, precreate the declared writable paths, build per-app
//!     cgroups from the policies' cgroupLimits, start context-bus-daemon
//!     confined if the image has it, and start every app under agent-init as
//!     its own uid inside its own cgroup.
//!  3. A long-lived RPC relay over vsock, and separate log and control streams.
//!
//! Configuration comes from the environment the kernel hands PID 1 (libkrun
//! puts `--env K=V` on the kernel command line):
//!   BERTH_VM_APPS               share tags, comma separated (default: one app, tag "app")
//!   BERTH_VM_RPC                socket (default) | stdio
//!   BERTH_REQUIRE_ENFORCEMENT   passed to agent-init (default 1)
//!   BERTH_REQUIRE_APP_CGROUPS   refuse to start an app without its cgroup limits (default 1)
//!   BERTH_DISABLE_APP_CGROUPS   1 = no per-app cgroups at all (implies not required)
//!   BERTH_DAEMON_MEMORY_RESERVE_MB  (default 256)
//!   BERTH_DISABLE_DAEMON_CONFINEMENT 1 = context-bus-daemon as root, unconfined
//!   BERTH_VM_STOP_GRACE_MS      SIGTERM-to-SIGKILL grace at shutdown (default 3000)
//!   BERTH_STATE_DEV             per-sandbox state disk (/dev/vdX): ext4 on /state, /state/workspace on /workspace

mod cgroup;
mod hub;
mod plan;
mod relay;
mod sys;

use cgroup::Cgroups;
use plan::{AppSpec, Owner, Policy, RpcMode};
use serde_json::{json, Value};
use std::ffi::CString;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const AGENT_INIT: &str = "/usr/local/bin/agent-init";
const POLICY_COMPILER: &str = "/opt/berth/sdk-node/generate-capability-policy.mjs";
const CONTEXT_BUS_DAEMON: &str = "/usr/local/bin/context-bus-daemon";
const NODE: &str = "/usr/bin/node";
const PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const POLICY_DIR: &str = "/run/berth/policy";

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok()
}

struct Config {
    apps: Vec<AppSpec>,
    rpc: RpcMode,
    require_enforcement: bool,
    cgroups_disabled: bool,
    require_cgroups: bool,
    reserve_mb: u64,
    confine_daemons: bool,
    grace: Duration,
    context_bus_socket: String,
}

impl Config {
    fn from_env() -> Result<Config, String> {
        let cgroups_disabled = plan::flag(env("BERTH_DISABLE_APP_CGROUPS").as_deref(), false);
        Ok(Config {
            apps: plan::parse_apps(env("BERTH_VM_APPS").as_deref())?,
            rpc: plan::rpc_mode(env("BERTH_VM_RPC").as_deref())?,
            require_enforcement: plan::flag(env("BERTH_REQUIRE_ENFORCEMENT").as_deref(), true),
            cgroups_disabled,
            require_cgroups: !cgroups_disabled && plan::flag(env("BERTH_REQUIRE_APP_CGROUPS").as_deref(), true),
            reserve_mb: env("BERTH_DAEMON_MEMORY_RESERVE_MB").and_then(|v| v.parse().ok()).unwrap_or(plan::DAEMON_RESERVE_MB),
            confine_daemons: !plan::flag(env("BERTH_DISABLE_DAEMON_CONFINEMENT").as_deref(), false),
            grace: Duration::from_millis(env("BERTH_VM_STOP_GRACE_MS").and_then(|v| v.parse().ok()).unwrap_or(3000)),
            context_bus_socket: env("BERTH_CONTEXT_BUS_SOCKET").unwrap_or_else(|| "/tmp/berth-context-bus.sock".into()),
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AppState {
    Pending,
    Refused,
    Running,
    Ready,
    Exited,
}

impl AppState {
    fn as_str(&self) -> &'static str {
        match self {
            AppState::Pending => "pending",
            AppState::Refused => "refused",
            AppState::Running => "running",
            AppState::Ready => "ready",
            AppState::Exited => "exited",
        }
    }
}

struct AppRec {
    spec: AppSpec,
    name: Option<String>,
    state: AppState,
    pid: Option<i32>,
    exit: Option<sys::Exit>,
    cgroup: Option<PathBuf>,
    started_ms: Option<u64>,
    ready_ms: Option<u64>,
    reason: Option<String>,
    gone: relay::Gone,
}

struct Supervisor {
    apps: Mutex<Vec<AppRec>>,
    daemons: Mutex<Vec<(String, i32)>>,
    shutdown: Mutex<Option<String>>,
    cgroups: Mutex<Option<Cgroups>>,
    rpc: RpcMode,
}

impl hub::Control for Supervisor {
    fn status(&self) -> Value {
        let cg = self.cgroups.lock().unwrap();
        let apps: Vec<Value> = self
            .apps
            .lock()
            .unwrap()
            .iter()
            .map(|a| {
                let cgroup = match (&*cg, &a.cgroup) {
                    (Some(c), Some(dir)) => json!({
                        "path": dir.strip_prefix(&c.root).map(|p| format!("/{}", p.display())).unwrap_or_default(),
                        "limits": c.read_limits(dir).into_iter().map(|(k, v)| (k, Value::String(v))).collect::<serde_json::Map<_, _>>(),
                        "procs": c.procs(dir),
                    }),
                    _ => Value::Null,
                };
                json!({
                    "index": a.spec.index,
                    "tag": a.spec.tag,
                    "name": a.name,
                    "uid": a.spec.uid,
                    "rpcPort": a.spec.rpc_port,
                    "state": a.state.as_str(),
                    "pid": a.pid,
                    "exit": a.exit.map(|e| e.json()),
                    "startedMs": a.started_ms,
                    "readyMs": a.ready_ms,
                    "reason": a.reason,
                    "cgroup": cgroup,
                })
            })
            .collect();
        let daemons: Vec<Value> = self.daemons.lock().unwrap().iter().map(|(n, p)| json!({ "name": n, "pid": p })).collect();
        let daemons_cg = cg.as_ref().map(|c| json!({ "path": "/berth/daemons", "procs": c.procs(&c.daemons()) }));
        json!({ "apps": apps, "daemons": daemons, "daemonsCgroup": daemons_cg, "rpc": if self.rpc == RpcMode::Socket { "socket" } else { "stdio" } })
    }

    fn request_shutdown(&self, reason: &str) {
        self.shutdown.lock().unwrap().get_or_insert_with(|| reason.to_string());
        // Wakes the main thread's sigtimedwait.
        sys::kill(std::process::id() as i32, libc::SIGUSR1);
    }
}

fn s(v: impl Into<Value>) -> Value {
    v.into()
}

fn main() {
    if std::process::id() != 1 {
        // libkrun's init.krun execs its payload, so berth-init is PID 1 in
        // every boot tested. Should a libkrun mode ever fork it instead,
        // become the subreaper so orphans are still ours to reap. Anywhere
        // else (KRUN_INIT unset) this is not a guest, and it stops here.
        if env("KRUN_INIT").is_none() && env("BERTH_INIT_ALLOW_NOT_PID1").as_deref() != Some("1") {
            eprintln!("berth-init: not PID 1; this is a guest init and does not run on a host");
            std::process::exit(2);
        }
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) };
        eprintln!("[berth-init] WARNING: running as pid {}, not 1: acting as child subreaper", std::process::id());
    }
    // A Rust panic in PID 1 would end in a kernel panic; power off instead,
    // having said why.
    std::panic::set_hook(Box::new(|info| {
        eprintln!("[berth-init] FATAL: {info}");
        sys::power_off();
    }));

    let sigs = sys::handled_signals();
    sys::block_signals(&sigs);
    sys::disable_cad();
    early_mounts();

    let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/uuid").map(|s| s.trim().to_string()).unwrap_or_else(|_| "unknown".into());
    hub::init(boot_id);
    let release = std::fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default();
    let lsm = std::fs::read_to_string("/sys/kernel/security/lsm").unwrap_or_else(|_| "none".into());
    hub::event("boot_start", json!({ "kernel": release.trim(), "lsm": lsm.trim() }));
    // Not inherited by anything berth-init starts: every child gets an
    // explicit environment.
    std::env::set_var("PATH", PATH);

    let cfg = Config::from_env();
    let sup: &'static Supervisor = Box::leak(Box::new(Supervisor {
        apps: Mutex::new(Vec::new()),
        daemons: Mutex::new(Vec::new()),
        shutdown: Mutex::new(None),
        cgroups: Mutex::new(None),
        rpc: cfg.as_ref().map_or(RpcMode::Socket, |c| c.rpc),
    }));

    // The host-facing streams come up first, so a failed boot is reported on
    // the control port rather than only on the console.
    match sys::vsock_listen(plan::CONTROL_PORT) {
        Ok(l) => hub::serve_control(l, sup),
        Err(e) => hub::info(&format!("WARNING: cannot listen on vsock:{} (control): {e}", plan::CONTROL_PORT)),
    }
    match sys::vsock_listen(plan::LOG_PORT) {
        Ok(l) => hub::serve_logs(l),
        Err(e) => hub::info(&format!("WARNING: cannot listen on vsock:{} (logs): {e}", plan::LOG_PORT)),
    }

    let cfg = match cfg {
        Ok(c) => c,
        Err(e) => fail_boot(sup, &sigs, &e, Duration::from_millis(0)),
    };
    {
        let mut apps = sup.apps.lock().unwrap();
        for spec in &cfg.apps {
            apps.push(AppRec {
                spec: spec.clone(),
                name: None,
                state: AppState::Pending,
                pid: None,
                exit: None,
                cgroup: None,
                started_ms: None,
                ready_ms: None,
                reason: None,
                gone: Arc::new(AtomicBool::new(false)),
            });
        }
    }

    if let Err(e) = boot(sup, &cfg) {
        fail_boot(sup, &sigs, &e, cfg.grace);
    }
    supervise(sup, &sigs, &cfg);
}

fn early_mounts() {
    let nsd = libc::MS_NOSUID | libc::MS_NODEV;
    let m = |src: &str, dst: &str, fs: &str, flags: libc::c_ulong, data: Option<&str>| {
        if let Err(e) = sys::ensure_mount(src, dst, fs, flags, data) {
            eprintln!("[berth-init] WARNING: mount {fs} on {dst}: {e}");
        }
    };
    m("proc", "/proc", "proc", nsd | libc::MS_NOEXEC, None);
    m("sysfs", "/sys", "sysfs", nsd | libc::MS_NOEXEC, None);
    m("devtmpfs", "/dev", "devtmpfs", libc::MS_NOSUID, Some("mode=0755"));
    m("devpts", "/dev/pts", "devpts", libc::MS_NOSUID | libc::MS_NOEXEC, Some("newinstance,ptmxmode=0666,mode=0620,gid=5"));
    m("shm", "/dev/shm", "tmpfs", nsd, Some("mode=1777"));
    m("securityfs", "/sys/kernel/security", "securityfs", nsd | libc::MS_NOEXEC, None);
    // favordynmods: moving a process between cgroups otherwise waits for an
    // RCU grace period (cgroup_threadgroup_rwsem), ~20 ms each time on this
    // guest, and berth-init moves itself and every app it starts. The cost
    // moves to fork/exit, which a sandbox does far less of than a host.
    if !sys::is_mounted("/sys/fs/cgroup") {
        let _ = std::fs::create_dir_all("/sys/fs/cgroup");
        if sys::mount("cgroup2", "/sys/fs/cgroup", "cgroup2", nsd | libc::MS_NOEXEC, Some("nsdelegate,favordynmods")).is_err() {
            m("cgroup2", "/sys/fs/cgroup", "cgroup2", nsd | libc::MS_NOEXEC, Some("nsdelegate"));
        }
    } else {
        // Mounted by init.krun: ask for the option on a remount.
        let _ = sys::mount("cgroup2", "/sys/fs/cgroup", "cgroup2", libc::MS_REMOUNT | nsd | libc::MS_NOEXEC, Some("nsdelegate,favordynmods"));
    }
    m("tmpfs", "/run", "tmpfs", nsd, Some("mode=0755"));
    m("tmpfs", "/tmp", "tmpfs", nsd, Some("mode=1777"));
}

fn phase(name: &str, extra: Value) {
    let mut v = json!({ "phase": name });
    if let (Some(o), Value::Object(e)) = (v.as_object_mut(), extra) {
        o.extend(e);
    }
    hub::event("boot_phase", v);
}

fn boot(sup: &'static Supervisor, cfg: &Config) -> Result<(), String> {
    sys::sethostname("berth");
    if let Err(e) = sys::loopback_up() {
        hub::info(&format!("WARNING: could not bring lo up: {e}"));
    }
    let nsd = libc::MS_NOSUID | libc::MS_NODEV;

    // --- Filesystems the apps see. ---
    let mut fresh_mounts: Vec<&str> = Vec::new();
    match env("BERTH_STATE_DEV") {
        // feat/vm-image's per-sandbox state disk: ext4, formatted on first
        // boot, /state/workspace bound onto /workspace so it survives a reboot.
        Some(dev) => mount_state(&dev)?,
        None => {
            sys::ensure_mount("tmpfs", "/workspace", "tmpfs", nsd, Some("mode=0755")).map_err(|e| format!("cannot mount /workspace: {e}"))?;
        }
    }
    // Either way its root is (re)owned by the precreate pass each boot.
    fresh_mounts.push("/workspace");
    match sys::ensure_mount("tmpfs", "/context", "tmpfs", nsd, Some("mode=0755")) {
        Ok(_) => fresh_mounts.push("/context"),
        Err(e) => hub::info(&format!("no /context in this image ({e}); an app declaring /context cannot write it")),
    }
    if cfg.apps.len() > 1 {
        sys::ensure_mount("tmpfs", "/app", "tmpfs", nsd, Some("mode=0755,size=64k")).map_err(|e| format!("cannot mount /app: {e}"))?;
    }
    for a in &cfg.apps {
        let _ = std::fs::create_dir_all(&a.dir);
        sys::mount(&a.tag, &a.dir, "virtiofs", libc::MS_RDONLY | nsd, None)
            .map_err(|e| format!("cannot mount virtio-fs share {:?} at {}: {e}", a.tag, a.dir))?;
    }
    sys::install_dir("/run/berth", 0o755, 0, 0).map_err(|e| format!("cannot create /run/berth: {e}"))?;
    sys::install_dir(POLICY_DIR, 0o755, 0, 0).map_err(|e| format!("cannot create {POLICY_DIR}: {e}"))?;
    phase("mounts", json!({ "apps": cfg.apps.iter().map(|a| json!({ "tag": a.tag, "dir": a.dir })).collect::<Vec<_>>() }));

    // --- Cgroups. Set up before anything is started, so every daemon is
    // born in /berth/daemons. ---
    if cfg.cgroups_disabled {
        hub::event("cgroup_delegation", json!({ "status": "inactive", "reason": "BERTH_DISABLE_APP_CGROUPS=1" }));
    } else {
        let cg = Cgroups::new("/sys/fs/cgroup");
        let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
        match cg.setup(std::process::id(), plan::meminfo_bytes(&meminfo, "MemTotal"), cfg.reserve_mb) {
            Ok(s) => {
                hub::info(&format!(
                    "per-app cgroups active (controllers: {}): berth-init and daemons in /berth/daemons (cpu.weight {}, {} MiB held back from the apps), apps under /berth/apps (memory.max {})",
                    s.controllers.join(" "),
                    plan::DAEMON_CPU_WEIGHT,
                    cfg.reserve_mb,
                    s.apps_memory_max.map_or("max".into(), |m| m.to_string())
                ));
                hub::event(
                    "cgroup_delegation",
                    json!({ "status": "active", "controllers": s.controllers.join(" "), "daemonsCpuWeight": plan::DAEMON_CPU_WEIGHT, "daemonReserveMemoryMb": cfg.reserve_mb.to_string(), "appsMemoryMax": s.apps_memory_max.map_or("max".into(), |m| m.to_string()) }),
                );
                *sup.cgroups.lock().unwrap() = Some(cg);
            }
            Err(reason) => {
                if cfg.require_cgroups {
                    hub::event("cgroup_delegation_refused", json!({ "reason": reason }));
                    return Err(format!("BERTH_REQUIRE_APP_CGROUPS is set but per-app cgroups are unavailable: {reason}"));
                }
                hub::info(&format!("WARNING: per-app cgroups inactive: {reason} — each app is bounded only by the VM's own caps"));
                hub::event("cgroup_delegation", json!({ "status": "inactive", "reason": reason }));
            }
        }
    }
    phase("cgroups", json!({}));

    // --- Policies, compiled in parallel (each is one node start). ---
    let policies = compile_policies(&cfg.apps);
    let mut compiled: Vec<(usize, Policy)> = Vec::new();
    {
        let mut apps = sup.apps.lock().unwrap();
        for (i, res) in policies.into_iter().enumerate() {
            match res {
                Ok(p) => {
                    apps[i].name = Some(p.app_name.clone());
                    compiled.push((i, p));
                }
                Err(e) => {
                    hub::info(&format!("WARNING: could not compile the capability policy for share {:?}: {e} — not starting it", cfg.apps[i].tag));
                    apps[i].state = AppState::Refused;
                    apps[i].reason = Some(e);
                }
            }
        }
    }
    {
        let mut names: Vec<&str> = compiled.iter().map(|(_, p)| p.app_name.as_str()).collect();
        names.sort();
        if names.windows(2).any(|w| w[0] == w[1]) {
            return Err(format!("two apps in this sandbox have the same name ({names:?})"));
        }
    }
    if compiled.is_empty() {
        return Err("no app's capability policy compiled; nothing to start".into());
    }
    phase("policies", json!({ "apps": compiled.iter().map(|(_, p)| p.app_name.clone()).collect::<Vec<_>>() }));

    // --- Identities and per-app directories (provision_app_identity). ---
    let with_bus = Path::new(CONTEXT_BUS_DAEMON).exists();
    let ident: Vec<(String, u32, Vec<u32>)> =
        compiled.iter().map(|(i, p)| (p.app_name.clone(), cfg.apps[*i].uid, plan::supplementary_gids(cfg.apps[*i].uid, p))).collect();
    install_identities(&ident, with_bus);
    for (name, uid, _) in &ident {
        for (dir, mode) in [(format!("/run/berth/{name}"), 0o711), (format!("/run/berth/{name}/peers"), 0o711), (format!("/tmp/{name}"), 0o700)] {
            if let Err(e) = sys::install_dir(&dir, mode, *uid, *uid) {
                hub::info(&format!("WARNING: could not create {dir}: {e}"));
            }
        }
    }
    let triples: Vec<(String, u32, &Policy)> = compiled.iter().map(|(i, p)| (p.app_name.clone(), cfg.apps[*i].uid, p)).collect();
    let (grants, warnings) = plan::invoke_grants(&triples);
    for w in warnings {
        hub::info(&format!("WARNING: {w}"));
    }
    for g in grants {
        match sys::install_dir(&g.dir, 0o2710, g.target_uid, g.caller_gid) {
            Ok(()) => hub::info(&format!("{} may invoke {}'s exports (app:invoke:{}) via {}", g.caller, g.target, g.target, g.dir)),
            Err(e) => hub::info(&format!("WARNING: could not create {}: {e} — {}'s app:invoke:{} calls will fail", g.dir, g.caller, g.target)),
        }
    }

    // --- Declared writable paths (precreate_declared_paths). ---
    let owners: Vec<(u32, &Policy)> = compiled.iter().map(|(i, p)| (cfg.apps[*i].uid, p)).collect();
    let (plan_paths, warnings) = plan::precreate_plan(&owners, &|p| Path::new(p).exists(), &fresh_mounts);
    for w in warnings {
        hub::info(&format!("WARNING: {w}"));
    }
    for pc in plan_paths {
        if let Err(e) = std::fs::create_dir_all(&pc.path) {
            hub::info(&format!("WARNING: could not create declared path {}: {e}", pc.path));
            continue;
        }
        let r = match pc.owner {
            Owner::App(uid) => sys::chown(&pc.path, uid, uid).and_then(|_| sys::chmod(&pc.path, 0o755)),
            Owner::Shared => sys::chown(&pc.path, 0, plan::SHARED_GID).and_then(|_| sys::chmod(&pc.path, 0o2775)),
        };
        match (&pc.owner, r) {
            (_, Err(e)) => hub::info(&format!("WARNING: could not set ownership of {}: {e}", pc.path)),
            (Owner::App(uid), Ok(())) => hub::info(&format!("created declared path {} for uid {uid}", pc.path)),
            (Owner::Shared, Ok(())) => hub::info(&format!("created declared path {} shared by several apps (root:berth, setgid)", pc.path)),
        }
    }
    // secure_capability_policy: readable by the app, never writable by it.
    for (i, _) in &compiled {
        let path = policy_path(&cfg.apps[*i]);
        let _ = sys::chown(&path, 0, cfg.apps[*i].uid).and_then(|_| sys::chmod(&path, 0o640));
    }
    phase("identities", json!({}));

    // --- context-bus-daemon, confined, before any app. ---
    if with_bus {
        start_context_bus(sup, cfg);
    } else {
        hub::info(&format!("context-bus-daemon is not in this image ({CONTEXT_BUS_DAEMON}); apps fall back to the SDK's local context bus"));
        hub::event("daemon_absent", json!({ "daemon": "context-bus", "path": CONTEXT_BUS_DAEMON }));
    }
    phase("daemons", json!({}));

    // --- The apps. ---
    for (i, policy) in &compiled {
        start_app(sup, cfg, &cfg.apps[*i], policy);
    }
    phase("apps_started", json!({}));
    Ok(())
}

/// ext2/3/4 superblock magic (0xEF53, little endian) at byte 1080.
fn has_ext4(dev: &str) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let mut m = [0u8; 2];
    std::fs::File::open(dev).and_then(|mut f| f.seek(SeekFrom::Start(1080)).and_then(|_| f.read_exact(&mut m))).is_ok() && m == [0x53, 0xef]
}

fn mount_state(dev: &str) -> Result<(), String> {
    if !dev.starts_with("/dev/vd") || dev.contains("..") {
        return Err(format!("BERTH_STATE_DEV={dev:?} is not a virtio block device"));
    }
    if !has_ext4(dev) {
        hub::info(&format!("state disk {dev} is blank: formatting ext4"));
        // nodiscard: a whole-device discard makes libkrun truncate the image.
        let st = Command::new("/sbin/mkfs.ext4")
            .args(["-q", "-L", "berth-state", "-m", "0", "-E", "root_owner=0:0,nodiscard", dev])
            .env_clear()
            .env("PATH", PATH)
            .stdin(Stdio::null())
            .status()
            .map_err(|e| format!("cannot run mkfs.ext4 for the state disk: {e}"))?;
        if !st.success() {
            return Err(format!("mkfs.ext4 {dev} failed: {st}"));
        }
    }
    let nsd = libc::MS_NOSUID | libc::MS_NODEV;
    sys::ensure_mount(dev, "/state", "ext4", nsd, None).map_err(|e| format!("cannot mount the state disk {dev} on /state: {e}"))?;
    std::fs::create_dir_all("/state/workspace").map_err(|e| format!("cannot create /state/workspace: {e}"))?;
    sys::bind("/state/workspace", "/workspace").map_err(|e| format!("cannot bind /state/workspace onto /workspace: {e}"))?;
    hub::info(&format!("state disk {dev} on /state, /workspace persistent"));
    Ok(())
}

fn policy_path(a: &AppSpec) -> String {
    format!("{POLICY_DIR}/{}.json", a.tag)
}

/// Runs the image's policy compiler once per app, all at once, as root, from
/// its image-owned path, with NODE_OPTIONS/NODE_PATH absent (the environment
/// is explicit) — run_node_sdk_tool's rules. The working directory is the
/// app's, which the compiler reads as the app's root.
fn compile_policies(apps: &[AppSpec]) -> Vec<Result<Policy, String>> {
    let children: Vec<Result<std::process::Child, String>> = apps
        .iter()
        .map(|a| {
            if !Path::new(&format!("{}/berth.yml", a.dir)).exists() {
                return Err(format!("no berth.yml in {}", a.dir));
            }
            Command::new(NODE)
                .arg(POLICY_COMPILER)
                .current_dir(&a.dir)
                .env_clear()
                .env("PATH", PATH)
                .env("HOME", "/root")
                .env("BERTH_MANIFEST_PATH", format!("{}/berth.yml", a.dir))
                .env("BERTH_CAPABILITY_POLICY", policy_path(a))
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("cannot run {NODE} {POLICY_COMPILER}: {e}"))
        })
        .collect();
    children
        .into_iter()
        .zip(apps)
        .map(|(child, a)| {
            let out = child?.wait_with_output().map_err(|e| format!("policy compiler: {e}"))?;
            for line in String::from_utf8_lossy(&out.stdout).lines().chain(String::from_utf8_lossy(&out.stderr).lines()) {
                hub::log("berth-init", "policy", line);
            }
            if !out.status.success() {
                return Err(format!("policy compiler exited with {}", out.status));
            }
            let text = std::fs::read_to_string(policy_path(a)).map_err(|e| format!("cannot read {}: {e}", policy_path(a)))?;
            plan::parse_policy(&text)
        })
        .collect()
}

fn install_identities(apps: &[(String, u32, Vec<u32>)], with_bus: bool) {
    let passwd = std::fs::read_to_string("/etc/passwd").unwrap_or_default();
    let group = std::fs::read_to_string("/etc/group").unwrap_or_default();
    let (p, g) = plan::identity_files(&passwd, &group, apps, with_bus);
    let _ = sys::install_dir("/run/berth/etc", 0o755, 0, 0);
    for (name, content) in [("passwd", p), ("group", g)] {
        let staged = format!("/run/berth/etc/{name}");
        let target = format!("/etc/{name}");
        let r = std::fs::write(&staged, content).and_then(|_| sys::chmod(&staged, 0o644)).and_then(|_| sys::bind(&staged, &target));
        if let Err(e) = r {
            hub::info(&format!("WARNING: could not install {target} for the app identities: {e} (agent-init uses numeric ids; names will not resolve)"));
        }
    }
}

/// The environment of one app's agent-init and runtime. Explicit: nothing of
/// PID 1's own environment (the kernel command line's) is passed on.
fn app_env(cfg: &Config, a: &AppSpec, policy: &Policy) -> Vec<(String, String)> {
    let name = &policy.app_name;
    let tmp = format!("/tmp/{name}");
    let gids = plan::supplementary_gids(a.uid, policy).iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let mut e: Vec<(String, String)> = vec![
        ("PATH".into(), PATH.into()),
        ("HOME".into(), tmp.clone()),
        ("TMPDIR".into(), tmp.clone()),
        ("TMUX_TMPDIR".into(), tmp.clone()),
        ("XDG_CONFIG_HOME".into(), format!("{tmp}/.config")),
        ("XDG_CACHE_HOME".into(), format!("{tmp}/.cache")),
        ("BERTH_BOOT_ID".into(), hub::boot_id().into()),
        ("BERTH_APP_NAME".into(), name.clone()),
        ("BERTH_APP_UID".into(), a.uid.to_string()),
        ("BERTH_APP_GID".into(), a.uid.to_string()),
        ("BERTH_APP_SUPPLEMENTARY_GIDS".into(), gids),
        ("BERTH_CAPABILITY_POLICY".into(), policy_path(a)),
        ("BERTH_MANIFEST_PATH".into(), format!("{}/berth.yml", a.dir)),
        ("BERTH_REQUIRE_ENFORCEMENT".into(), if cfg.require_enforcement { "1" } else { "0" }.into()),
        ("BERTH_WORKSPACE_ROOT".into(), "/workspace".into()),
        ("BERTH_CONTEXT_BUS_SOCKET".into(), cfg.context_bus_socket.clone()),
        ("BERTH_SHARED_GID".into(), plan::SHARED_GID.to_string()),
        // No semantic-fs daemon in the VM yet; see the design note.
        ("BERTH_NO_SEMANTIC_FS".into(), "1".into()),
    ];
    if cfg.rpc == RpcMode::Socket {
        e.push(("BERTH_RPC_SOCKET".into(), format!("/run/berth/{name}/rpc.sock")));
    }
    let entry = format!("{}/dist/index.mjs", a.dir);
    if Path::new(&entry).exists() {
        e.push(("BERTH_APP_ENTRY".into(), entry));
    }
    if let Some(v) = env("NODE_ENV") {
        e.push(("NODE_ENV".into(), v));
    }
    e
}

/// What runs in the child between fork and exec: join the cgroup (so nothing
/// the app ever starts is outside it), start a new session (so shutdown can
/// signal the whole tree), and clear the signal mask PID 1 runs with.
/// Only async-signal-safe calls.
fn child_setup(cgroup_procs: Option<CString>) -> impl FnMut() -> std::io::Result<()> + Send + Sync + 'static {
    move || unsafe {
        if let Some(p) = &cgroup_procs {
            let fd = libc::open(p.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC);
            if fd < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // "0" is the writing process itself.
            let n = libc::write(fd, b"0".as_ptr().cast(), 1);
            let err = std::io::Error::last_os_error();
            libc::close(fd);
            if n != 1 {
                return Err(err);
            }
        }
        libc::setsid();
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::pthread_sigmask(libc::SIG_SETMASK, &set, std::ptr::null_mut());
        Ok(())
    }
}

fn start_context_bus(sup: &'static Supervisor, cfg: &Config) {
    let _ = std::fs::remove_file(&cfg.context_bus_socket);
    let socket_dir = Path::new(&cfg.context_bus_socket).parent().map(|p| p.display().to_string()).unwrap_or_else(|| "/tmp".into());
    let mut cmd;
    let mut envs: Vec<(String, String)> = vec![
        ("PATH".into(), PATH.into()),
        ("BERTH_BOOT_ID".into(), hub::boot_id().into()),
        ("BERTH_CONTEXT_BUS_SOCKET".into(), cfg.context_bus_socket.clone()),
        ("BERTH_SHARED_GID".into(), plan::SHARED_GID.to_string()),
    ];
    if cfg.confine_daemons {
        let policy = "/run/berth/daemon-policy.context-bus.json";
        let body = json!({
            "appName": "context-bus-daemon",
            "declaredCapabilities": ["daemon:context-bus"],
            "writePaths": [socket_dir],
            "readPaths": [],
            "networkPorts": [],
            "networkUnrestricted": false,
            "bindPorts": [],
        });
        if let Err(e) = std::fs::write(policy, body.to_string()).and_then(|_| sys::chmod(policy, 0o600)) {
            hub::info(&format!("WARNING: could not write {policy}: {e}; not starting context-bus-daemon"));
            return;
        }
        let u = plan::DAEMON_BUS_UID.to_string();
        cmd = Command::new(AGENT_INIT);
        cmd.arg(CONTEXT_BUS_DAEMON);
        envs.extend([
            ("BERTH_CAPABILITY_POLICY".to_string(), policy.to_string()),
            ("BERTH_APP_UID".into(), u.clone()),
            ("BERTH_APP_GID".into(), u.clone()),
            ("BERTH_APP_SUPPLEMENTARY_GIDS".into(), format!("{u},{}", plan::SHARED_GID)),
            ("BERTH_REQUIRE_ENFORCEMENT".into(), if cfg.require_enforcement { "1" } else { "0" }.into()),
        ]);
        hub::info(&format!("context-bus-daemon confined: uid {}, Landlock write scope {socket_dir}", plan::DAEMON_BUS_UID));
    } else {
        hub::info("WARNING: BERTH_DISABLE_DAEMON_CONFINEMENT=1 — context-bus-daemon runs as root with no Landlock domain");
        cmd = Command::new(CONTEXT_BUS_DAEMON);
    }
    cmd.env_clear()
        .envs(envs)
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Stays in /berth/daemons, where berth-init is.
    unsafe { cmd.pre_exec(child_setup(None)) };
    match cmd.spawn() {
        Ok(mut child) => {
            let pid = child.id() as i32;
            if let Some(o) = child.stdout.take() {
                relay::pipe_logs("context-bus".into(), "stdout", o, |_| {});
            }
            if let Some(e) = child.stderr.take() {
                relay::pipe_logs("context-bus".into(), "stderr", e, |_| {});
            }
            sup.daemons.lock().unwrap().push(("context-bus".into(), pid));
            // Reaped by the supervisor loop, never waited on here.
            std::mem::forget(child);
            let t = Instant::now();
            while t.elapsed() < Duration::from_secs(5) && !Path::new(&cfg.context_bus_socket).exists() {
                std::thread::sleep(Duration::from_millis(5));
            }
            let up = Path::new(&cfg.context_bus_socket).exists();
            hub::event("daemon_started", json!({ "daemon": "context-bus", "pid": pid, "socket": cfg.context_bus_socket, "listening": up, "confined": cfg.confine_daemons, "waitMs": t.elapsed().as_millis() as u64 }));
        }
        Err(e) => hub::info(&format!("WARNING: could not start context-bus-daemon: {e}")),
    }
}

fn start_app(sup: &'static Supervisor, cfg: &Config, a: &AppSpec, policy: &Policy) {
    let name = policy.app_name.clone();
    let refuse = |reason: String| {
        hub::info(&format!("FATAL: {reason} — not starting {name}"));
        hub::event("app_refused", json!({ "app": name, "reason": reason }));
        let mut apps = sup.apps.lock().unwrap();
        apps[a.index].state = AppState::Refused;
        apps[a.index].reason = Some(reason);
    };

    // --- Its cgroup (place_app_in_cgroup). ---
    let mut cgroup_procs = None;
    let cg = sup.cgroups.lock().unwrap();
    if let Some(cg) = cg.as_ref() {
        let (limits, skipped) = plan::app_limits(policy, plan::DEFAULT_APP_PIDS);
        let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
        let applied = cg.apply_app(&name, &limits, skipped, plan::meminfo_bytes(&meminfo, "SwapTotal"));
        if !applied.failed.is_empty() && cfg.require_cgroups {
            hub::event("cgroup_limits_refused", json!({ "app": name, "reason": applied.failed.join(", ") }));
            refuse(format!("BERTH_REQUIRE_APP_CGROUPS is set but {name}'s cgroup limits did not apply: {}", applied.failed.join(", ")));
            return;
        }
        let shown: Vec<String> = applied.limits.iter().map(|(f, v)| format!("{f}={}", v.replace(' ', "/"))).collect();
        hub::info(&format!(
            "{name} runs in cgroup /berth/apps/{name}: {}{}",
            shown.join(" "),
            if applied.skipped.is_empty() { String::new() } else { format!(" — skipped: {}", applied.skipped.join(", ")) }
        ));
        hub::event(
            "cgroup_limits_applied",
            json!({ "app": name, "cgroup": format!("/berth/apps/{name}"), "limits": applied.limits.iter().map(|(f, v)| (f.clone(), s(v.clone()))).collect::<serde_json::Map<_, _>>(), "skipped": applied.skipped.join(", ") }),
        );
        cgroup_procs = Some(CString::new(format!("{}/cgroup.procs", applied.dir.display())).unwrap());
        sup.apps.lock().unwrap()[a.index].cgroup = Some(applied.dir);
    }
    drop(cg);

    // --- The process: agent-init -> node runtime, as the app's uid. ---
    let runtime = if Path::new(&format!("{}/runtime.mjs", a.dir)).exists() {
        format!("{}/runtime.mjs", a.dir)
    } else {
        "node_modules/@berthos/sdk/dist/runtime.js".to_string()
    };
    let mut cmd = Command::new(AGENT_INIT);
    cmd.arg(NODE)
        .arg(&runtime)
        .current_dir(&a.dir)
        .env_clear()
        .envs(app_env(cfg, a, policy))
        .stdin(if cfg.rpc == RpcMode::Stdio { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe { cmd.pre_exec(child_setup(cgroup_procs)) };
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            refuse(format!("could not start {name} (agent-init {NODE} {runtime}) in its cgroup: {e}"));
            return;
        }
    };
    let pid = child.id() as i32;
    let started = sys::uptime_ms();
    {
        let mut apps = sup.apps.lock().unwrap();
        let r = &mut apps[a.index];
        r.pid = Some(pid);
        r.state = AppState::Running;
        r.started_ms = Some(started);
    }
    hub::event("app_started", json!({ "app": name, "pid": pid, "uid": a.uid, "rpcPort": a.rpc_port, "rpc": if cfg.rpc == RpcMode::Socket { "socket" } else { "stdio" } }));

    let marker = format!("[berth:runtime] \"{name}\" ready");
    let index = a.index;
    let app_name = name.clone();
    if let Some(e) = child.stderr.take() {
        relay::pipe_logs(name.clone(), "stderr", e, move |line| {
            if line.contains(&marker) {
                let mut apps = sup.apps.lock().unwrap();
                let r = &mut apps[index];
                if r.ready_ms.is_none() {
                    r.ready_ms = Some(sys::uptime_ms());
                    r.state = AppState::Ready;
                    drop(apps);
                    hub::event("app_ready", json!({ "app": app_name, "pid": pid }));
                }
            }
        });
    }
    let gone = sup.apps.lock().unwrap()[a.index].gone.clone();
    let listener = match sys::vsock_listen(a.rpc_port) {
        Ok(l) => Some(l),
        Err(e) => {
            hub::info(&format!("WARNING: cannot listen on vsock:{} for {name}'s RPC: {e}", a.rpc_port));
            None
        }
    };
    match cfg.rpc {
        RpcMode::Socket => {
            if let Some(o) = child.stdout.take() {
                relay::pipe_logs(name.clone(), "stdout", o, |_| {});
            }
            if let Some(l) = listener {
                relay::serve_socket(name.clone(), a.rpc_port, l, format!("/run/berth/{name}/rpc.sock"), gone);
            }
        }
        RpcMode::Stdio => {
            let mux = relay::StdioMux::new(name.clone(), child.stdin.take().expect("piped stdin"));
            if let Some(o) = child.stdout.take() {
                mux.read_stdout(o);
            }
            if let Some(l) = listener {
                mux.serve(a.rpc_port, l);
            }
        }
    }
    // Reaped by the supervisor loop (waitpid(-1)), never waited on here.
    std::mem::forget(child);
}

/// The main loop: reap, record exits, and shut down when asked or when no app
/// is left running.
fn supervise(sup: &'static Supervisor, sigs: &libc::sigset_t, cfg: &Config) -> ! {
    hub::event("boot_complete", json!({ "apps": hub_status_apps(sup) }));
    loop {
        let sig = sys::wait_signal(sigs, Duration::from_millis(500));
        reap_and_record(sup);
        if let Some(s) = sig {
            match s {
                libc::SIGTERM | libc::SIGINT | libc::SIGPWR | libc::SIGHUP => {
                    sup.shutdown.lock().unwrap().get_or_insert_with(|| format!("signal {s}"));
                }
                _ => {}
            }
        }
        if let Some(reason) = sup.shutdown.lock().unwrap().clone() {
            shutdown(sup, sigs, &reason, cfg.grace, 0);
        }
        let live = sup.apps.lock().unwrap().iter().any(|a| matches!(a.state, AppState::Running | AppState::Ready));
        if !live {
            let code = if sup.apps.lock().unwrap().iter().all(|a| a.exit == Some(sys::Exit::Code(0))) { 0 } else { 1 };
            shutdown(sup, sigs, "every app has exited", cfg.grace, code);
        }
    }
}

fn hub_status_apps(sup: &Supervisor) -> Value {
    sup.apps
        .lock()
        .unwrap()
        .iter()
        .map(|a| json!({ "name": a.name, "state": a.state.as_str(), "pid": a.pid, "rpcPort": a.spec.rpc_port }))
        .collect()
}

fn reap_and_record(sup: &Supervisor) {
    for (pid, exit) in sys::reap() {
        let mut apps = sup.apps.lock().unwrap();
        if let Some(a) = apps.iter_mut().find(|a| a.pid == Some(pid) && a.exit.is_none()) {
            a.exit = Some(exit);
            a.state = AppState::Exited;
            a.gone.store(true, Ordering::SeqCst);
            let name = a.name.clone();
            drop(apps);
            hub::info(&format!("{} (pid {pid}) exited: {:?}", name.as_deref().unwrap_or("?"), exit));
            hub::event("app_exited", json!({ "app": name, "pid": pid, "exit": exit.json() }));
            continue;
        }
        drop(apps);
        let mut d = sup.daemons.lock().unwrap();
        if let Some(pos) = d.iter().position(|(_, p)| *p == pid) {
            let (name, _) = d.remove(pos);
            drop(d);
            hub::info(&format!("WARNING: daemon {name} (pid {pid}) exited: {exit:?}"));
            hub::event("daemon_exited", json!({ "daemon": name, "pid": pid, "exit": exit.json() }));
        }
    }
}

fn fail_boot(sup: &'static Supervisor, sigs: &libc::sigset_t, reason: &str, grace: Duration) -> ! {
    hub::info(&format!("FATAL: {reason}"));
    hub::event("boot_failed", json!({ "reason": reason }));
    shutdown(sup, sigs, &format!("boot failed: {reason}"), grace, 1)
}

/// Stop everything, sync, unmount, power off. Never returns.
fn shutdown(sup: &Supervisor, sigs: &libc::sigset_t, reason: &str, grace: Duration, code: i32) -> ! {
    let t0 = Instant::now();
    hub::event("shutting_down", json!({ "reason": reason }));
    let pids = |sup: &Supervisor| -> Vec<i32> {
        let mut v: Vec<i32> = sup.apps.lock().unwrap().iter().filter(|a| a.exit.is_none()).filter_map(|a| a.pid).collect();
        v.extend(sup.daemons.lock().unwrap().iter().map(|(_, p)| *p));
        v
    };
    for pid in pids(sup) {
        // Each app and daemon leads its own session (child_setup), so the
        // negative pid reaches everything it started.
        sys::kill(-pid, libc::SIGTERM);
        sys::kill(pid, libc::SIGTERM);
    }
    let deadline = Instant::now() + grace;
    while !pids(sup).is_empty() && Instant::now() < deadline {
        sys::wait_signal(sigs, Duration::from_millis(20));
        reap_and_record(sup);
    }
    let killed = pids(sup);
    // Whatever is left, including anything that escaped its session.
    sys::kill(-1, libc::SIGKILL);
    let t = Instant::now();
    while t.elapsed() < Duration::from_millis(500) {
        reap_and_record(sup);
        if pids(sup).is_empty() {
            break;
        }
        sys::wait_signal(sigs, Duration::from_millis(10));
    }
    reap_and_record(sup);
    unsafe { libc::sync() };
    let mut unmounted = Vec::new();
    let mut failed = Vec::new();
    for mp in sys::mount_points() {
        // /proc, /sys, /dev and what is under them hold no data; the console
        // is on /dev. Everything else comes down, children first.
        if ["/proc", "/sys", "/dev"].iter().any(|k| mp == *k || mp.starts_with(&format!("{k}/"))) {
            continue;
        }
        match sys::umount(&mp) {
            Ok(()) => unmounted.push(mp),
            Err(e) => failed.push(format!("{mp}: {e}")),
        }
    }
    // A disk-backed root (feat/vm-image) is made read-only before power off;
    // a read-only virtio-fs root already is.
    let _ = sys::mount("", "/", "", libc::MS_REMOUNT | libc::MS_RDONLY, None);
    unsafe { libc::sync() };
    hub::event(
        "power_off",
        json!({
            "reason": reason,
            "exitCode": code,
            "apps": hub_status_apps(sup),
            "sigkilled": killed,
            "unmounted": unmounted.len(),
            "unmountFailed": failed,
            "shutdownMs": t0.elapsed().as_millis() as u64,
        }),
    );
    // Let the last event leave the vsock buffers before the VM disappears.
    std::thread::sleep(Duration::from_millis(30));
    sys::power_off()
}
