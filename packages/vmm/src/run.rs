// `berth-vmm run`: boot one sandbox from the pinned artifacts.
//
// It expands to the low-level options (main.rs): the kernel and rootfs this
// berth-vmm is pinned to, read from an artifacts directory laid out the way a
// download cache would be, one read-only virtio-fs share per app, an optional
// state disk, and the vsock port plan berth-init serves, each port mapped to
// a Unix socket in a run directory:
//
//   <run-dir>/control.sock   vsock 1024: berth-init's events; {"op":"status"},
//                            {"op":"shutdown"}
//   <run-dir>/logs.sock      vsock 1025: app and init log lines
//   <run-dir>/rpc-<i>.sock   vsock 5000+i: app i's RPC (line JSON)
//   <run-dir>/console.log    the guest console (hvc0)
//
// Before the VM starts it prints one `endpoints` line on stderr with these
// paths, which is what a host-side client (the CLI's local-vm adapter) reads.
// Every line that comes back from those sockets is untrusted guest output;
// see docs/design/microvm-guest-init.md, "The rule for the host side".
use crate::{die, pins, Opts, Share, Vsock};
use std::path::{Path, PathBuf};

/// The guest init the pinned command line starts (init=/sbin/berth-init).
pub const GUEST_INIT: &str = "/sbin/berth-init";
pub const CONTROL_PORT: u32 = 1024;
pub const LOG_PORT: u32 = 1025;
pub const RPC_PORT_BASE: u32 = 5000;
/// berth-init's own limit (plan::MAX_APPS).
const MAX_APPS: usize = 64;
/// sockaddr_un.sun_path on macOS is 104 bytes, NUL included.
const MAX_SOCKET_PATH: usize = 103;

const RUN_USAGE: &str = "usage: berth-vmm run --app DIR [--app DIR...] [options]

Boots one sandbox: the pinned kernel and base rootfs, berth-init as PID 1, one
app per --app (a directory holding berth.yml, dist/index.mjs and runtime.mjs;
scripts/build-apps.sh makes them), shared read-only. Runs in the foreground
until the guest powers off ({\"op\":\"shutdown\"} on control.sock, or every app exits).

  --app DIR             an app directory (repeatable; order fixes uid 10000+i
                        and RPC port 5000+i)
  --state DISK          per-sandbox state disk: /workspace survives a reboot.
                        Created sparse on first use. Without it /workspace is tmpfs
  --state-size MIB      size of a new --state disk (default 1024)
  --cpus N              vCPUs (default 2)
  --mem MIB             guest RAM (default 512 for one app, 1024 for more)
  --artifacts DIR       where the pinned artifacts are (default $BERTH_VMM_ARTIFACTS,
                        else ~/.berth/vm): kernel/sha256/<sha>/Image and
                        rootfs/rootfs-<sha>.erofs
  --rootfs IMG          another content-addressed rootfs instead of the pinned one
  --run-dir DIR         sockets and console log (default $TMPDIR/berth-vmm-<pid>);
                        created 0700
  --console-stderr      the guest console on stderr instead of console.log
  --env K=V             extra guest environment for berth-init (repeatable), e.g.
                        BERTH_VM_RPC=stdio. Ends up on the kernel command line
  --log-level N         libkrun log level 0-5 (default 1)";

fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| die("HOME is not set; pass --artifacts"))
}

/// A virtio-fs tag for a multi-app sandbox: the directory's name, cut down to
/// berth-init's [a-z0-9-]{1,32}.
fn tag_for(dir: &str) -> String {
    let base = Path::new(dir.trim_end_matches('/')).file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let t: String = base.chars().map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' { c } else { '-' }).take(32).collect();
    let t = t.trim_matches('-').to_string();
    if t.is_empty() {
        die(&format!("cannot derive an app tag from {dir:?}"));
    }
    t
}

fn need_file(path: &Path, what: &str) {
    if !path.is_file() {
        die(&format!("{what} not found at {}", path.display()));
    }
}

pub fn opts(argv: &[String]) -> Opts {
    let mut apps: Vec<String> = vec![];
    let mut state: Option<String> = None;
    let mut state_size_mib = 1024;
    let mut cpus = 2u8;
    let mut mem: Option<u32> = None;
    let mut artifacts: Option<String> = std::env::var("BERTH_VMM_ARTIFACTS").ok().filter(|s| !s.is_empty());
    let mut rootfs: Option<String> = None;
    let mut run_dir: Option<String> = None;
    let mut console_stderr = false;
    let mut env: Vec<String> = vec![];
    let mut log_level = 1;
    let mut args = argv.iter().cloned();
    while let Some(a) = args.next() {
        let mut val = || args.next().unwrap_or_else(|| die(&format!("{a} needs a value")));
        match a.as_str() {
            "--app" => apps.push(val()),
            "--state" => state = Some(val()),
            "--state-size" => state_size_mib = val().parse().unwrap_or_else(|_| die("bad --state-size")),
            "--cpus" => cpus = val().parse().unwrap_or_else(|_| die("bad --cpus")),
            "--mem" => mem = Some(val().parse().unwrap_or_else(|_| die("bad --mem"))),
            "--artifacts" => artifacts = Some(val()),
            "--rootfs" => rootfs = Some(val()),
            "--run-dir" => run_dir = Some(val()),
            "--console-stderr" => console_stderr = true,
            "--env" => env.push(val()),
            "--log-level" => log_level = val().parse().unwrap_or_else(|_| die("bad --log-level")),
            "-h" | "--help" => {
                println!("{RUN_USAGE}");
                std::process::exit(0);
            }
            other => die(&format!("run: unknown option {other}\n{RUN_USAGE}")),
        }
    }
    if apps.is_empty() {
        die(&format!("run: at least one --app\n{RUN_USAGE}"));
    }
    if apps.len() > MAX_APPS {
        die(&format!("run: at most {MAX_APPS} apps"));
    }
    if env.iter().any(|e| e.starts_with("BERTH_VM_APPS=") || e.starts_with("BERTH_STATE_DEV=")) {
        die("run: BERTH_VM_APPS and BERTH_STATE_DEV are set by run itself");
    }

    // The pinned artifacts.
    let art = PathBuf::from(artifacts.unwrap_or_else(|| format!("{}/.berth/vm", home())));
    let kernel = art.join("kernel/sha256").join(pins::kernel_pin()).join("Image");
    need_file(&kernel, "the pinned kernel (kernel/manifest.toml image_sha256)");
    let rootfs = match rootfs {
        Some(r) => r,
        None => {
            let p = art.join("rootfs").join(format!("rootfs-{}.erofs", pins::rootfs_pin()));
            need_file(&p, "the pinned rootfs (rootfs/manifest.toml image_sha256)");
            p.display().to_string()
        }
    };

    // Apps: one share each. One app is tag "app" at /app; several are
    // /app/<tag>, tagged by directory name.
    let tags: Vec<String> = if apps.len() == 1 { vec!["app".into()] } else { apps.iter().map(|a| tag_for(a)).collect() };
    for (i, t) in tags.iter().enumerate() {
        if tags[..i].contains(t) {
            die(&format!("run: two apps share the tag {t:?} (directory names must differ)"));
        }
    }
    let mut shares = vec![];
    for (dir, tag) in apps.iter().zip(&tags) {
        let d = std::fs::canonicalize(dir).unwrap_or_else(|e| die(&format!("app directory {dir}: {e}")));
        need_file(&d.join("berth.yml"), &format!("berth.yml of app {dir}"));
        shares.push(Share { tag: tag.clone(), path: d.display().to_string(), read_only: true });
    }

    // The run directory: sockets for the port plan, and the console.
    let run_dir = PathBuf::from(run_dir.unwrap_or_else(|| {
        let tmp = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into());
        format!("{}/berth-vmm-{}", tmp.trim_end_matches('/'), std::process::id())
    }));
    std::fs::create_dir_all(&run_dir).unwrap_or_else(|e| die(&format!("cannot create run dir {}: {e}", run_dir.display())));
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&run_dir, std::fs::Permissions::from_mode(0o700));
    }
    let run_dir = std::fs::canonicalize(&run_dir).unwrap_or(run_dir);
    let sock = |name: String| {
        let p = run_dir.join(name);
        let s = p.display().to_string();
        if s.len() > MAX_SOCKET_PATH {
            die(&format!("socket path {s} is longer than {MAX_SOCKET_PATH} bytes; pass a shorter --run-dir"));
        }
        // A stale socket from an earlier run would make libkrun's bind fail.
        let _ = std::fs::remove_file(&p);
        s
    };
    let control = sock("control.sock".into());
    let logs = sock("logs.sock".into());
    let rpc: Vec<String> = (0..apps.len()).map(|i| sock(format!("rpc-{i}.sock"))).collect();
    let mut vsocks = vec![
        Vsock { port: CONTROL_PORT, path: control.clone(), listen: true },
        Vsock { port: LOG_PORT, path: logs.clone(), listen: true },
    ];
    for (i, p) in rpc.iter().enumerate() {
        vsocks.push(Vsock { port: RPC_PORT_BASE + i as u32, path: p.clone(), listen: true });
    }
    let console = (!console_stderr).then(|| run_dir.join("console.log").display().to_string());

    let mut guest_env = vec![format!("BERTH_VM_APPS={}", tags.join(","))];
    guest_env.extend(env);
    crate::check_guest_env(&guest_env);

    let j = |s: &str| format!("{s:?}");
    let rpc_json: Vec<String> = tags
        .iter()
        .enumerate()
        .map(|(i, tag)| format!("{{\"index\":{i},\"tag\":{},\"app\":{},\"port\":{},\"socket\":{}}}", j(tag), j(&shares[i].path), RPC_PORT_BASE + i as u32, j(&rpc[i])))
        .collect();
    eprintln!(
        "{{\"source\":\"berth-vmm\",\"event\":\"endpoints\",\"runDir\":{},\"control\":{},\"logs\":{},\"rpc\":[{}],\"console\":{}}}",
        j(&run_dir.display().to_string()),
        j(&control),
        j(&logs),
        rpc_json.join(","),
        console.as_deref().map_or("null".into(), j)
    );

    Opts {
        cpus,
        mem_mib: mem.unwrap_or(if apps.len() == 1 { 512 } else { 1024 }),
        root: None,
        root_ro: false,
        rootfs: Some(rootfs),
        rootfs_sha256: None,
        state,
        state_size_mib,
        disks: vec![],
        shares,
        vsocks,
        env: guest_env,
        rlimits: vec![],
        workdir: None,
        kernel: Some(kernel.display().to_string()),
        libkrunfw_kernel: false,
        console_output: console,
        tsi: false,
        log_level,
        exec: vec![GUEST_INIT.into()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_from_directory_names() {
        assert_eq!(tag_for("/a/b/notes"), "notes");
        assert_eq!(tag_for("/a/b/My_App/"), "my-app");
        assert_eq!(tag_for(&format!("/x/{}", "a".repeat(40))), "a".repeat(32));
    }
}
