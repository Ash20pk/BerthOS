// berth-vmm: launcher that runs one Berth sandbox inside a libkrun microVM.
//
// One process per VM (HVF allows one VM per process). The VM gets:
//   - a fixed vCPU count and RAM size,
//   - the pinned Berth kernel (--kernel, checked against kernel/manifest.toml),
//   - a root filesystem: a content-addressed read-only image (--rootfs), or a
//     host directory over virtio-fs (--root, builder VMs),
//   - optionally a per-sandbox writable state disk (--state),
//   - NO network interface and TSI explicitly disabled, unless --tsi is passed
//     (only the rootfs/kernel *builder* VMs use --tsi, to reach the Alpine mirror),
//   - vsock ports mapped to host Unix sockets (the only way in or out),
//   - optionally the egress dialer (--egress-allow): the host half of the
//     guest's network access, behind vsock 1026 (egress.rs),
//   - optional extra virtio-fs shares and disks.
//
// libkrun's API is plain C; the handful of functions used here are declared by
// hand against include/libkrun.h at v1.19.6 (pinned: main has a v2 builder API).
//
// The binary that calls Hypervisor.framework must carry the
// com.apple.security.hypervisor entitlement; see scripts in packages/vmm/.
use std::ffi::CString;
use std::os::raw::{c_char, c_int};
use std::process::exit;

mod egress;
mod pins;
mod run;
mod sha256;

#[link(name = "krun")]
extern "C" {
    fn krun_init_log(target_fd: c_int, level: u32, style: u32, options: u32) -> i32;
    fn krun_create_ctx() -> i32;
    fn krun_set_vm_config(ctx: u32, num_vcpus: u8, ram_mib: u32) -> i32;
    fn krun_set_root(ctx: u32, root_path: *const c_char) -> i32;
    fn krun_add_disk(ctx: u32, block_id: *const c_char, disk_path: *const c_char, read_only: bool) -> i32;
    fn krun_set_root_disk_remount(ctx: u32, device: *const c_char, fstype: *const c_char, options: *const c_char) -> i32;
    fn krun_add_virtiofs3(ctx: u32, tag: *const c_char, path: *const c_char, shm_size: u64, read_only: bool) -> i32;
    fn krun_disable_implicit_vsock(ctx: u32) -> i32;
    fn krun_add_vsock(ctx: u32, tsi_features: u32) -> i32;
    fn krun_add_vsock_port2(ctx: u32, port: u32, path: *const c_char, listen: bool) -> i32;
    fn krun_set_workdir(ctx: u32, path: *const c_char) -> i32;
    fn krun_set_exec(ctx: u32, exec_path: *const c_char, argv: *const *const c_char, envp: *const *const c_char) -> i32;
    fn krun_set_kernel(ctx: u32, path: *const c_char, format: u32, initramfs: *const c_char, cmdline: *const c_char) -> i32;
    fn krun_set_console_output(ctx: u32, path: *const c_char) -> i32;
    fn krun_set_rlimits(ctx: u32, rlimits: *const *const c_char) -> i32;
    fn krun_start_enter(ctx: u32) -> i32;
}

const KRUN_TSI_HIJACK_INET: u32 = 1 << 0;
const KRUN_LOG_TARGET_DEFAULT: c_int = -1;
const KRUN_LOG_STYLE_AUTO: u32 = 0;

struct Vsock {
    port: u32,
    path: String,
    listen: bool,
}

struct Share {
    tag: String,
    path: String,
    read_only: bool,
}

struct Disk {
    id: String,
    path: String,
    read_only: bool,
}

struct Opts {
    cpus: u8,
    mem_mib: u32,
    root: Option<String>,
    root_ro: bool,
    rootfs: Option<String>,
    rootfs_sha256: Option<String>,
    state: Option<String>,
    state_size_mib: u64,
    disks: Vec<Disk>,
    shares: Vec<Share>,
    vsocks: Vec<Vsock>,
    env: Vec<String>,
    rlimits: Vec<String>,
    workdir: Option<String>,
    kernel: Option<String>,
    libkrunfw_kernel: bool,
    console_output: Option<String>,
    tsi: bool,
    log_level: u32,
    exec: Vec<String>,
    egress: Option<egress::Config>,
}

const USAGE: &str = "usage: berth-vmm run --app DIR [--app DIR...] [--state DISK] [run options]
       berth-vmm [options] [-- <guest-path> [args...]]
       berth-vmm egress-dialer --egress-allow LIST --egress-socket SOCK   (the dialer alone, no VM)

`berth-vmm run` boots a sandbox from the pinned artifacts; see `berth-vmm run --help`.
The low-level form below is what it expands to (and what builder VMs use).

  --cpus N                  vCPUs (default 1)
  --mem MIB                 guest RAM in MiB (default 512)
  --kernel IMG              boot this raw kernel Image. Its sha256 must equal the
                            image_sha256 pinned in kernel/manifest.toml (compiled
                            in), and the kernel command line comes from there too
  --libkrunfw-kernel        boot libkrunfw's bundled kernel instead (found via
                            DYLD_LIBRARY_PATH; unpinned, no Landlock). Builder VMs only
  --rootfs IMG              root filesystem: read-only erofs (or ext4) image, named
                            by its sha256 (<name>-<sha256>.erofs); hashed before boot
  --rootfs-sha256 HEX       expected sha256 of --rootfs, if its name doesn't carry it
  --state IMG               per-sandbox writable state disk (raw; the guest formats
                            it ext4 on first boot). Created sparse if missing
  --state-size MIB          size (the cap) of a newly created --state disk (default 1024)
  --root DIR                root filesystem: host directory over virtio-fs (builders)
  --root-ro                 expose --root read-only (guest needs tmpfs for writes)
  --disk ID:IMG[:ro]        extra raw disk (repeatable; after rootfs and state)
  --share TAG:DIR[:ro]      extra virtio-fs share (repeatable)
  --vsock PORT:SOCK[:listen]  map guest vsock PORT to host unix socket SOCK.
                            default: guest connects out, host listens on SOCK.
                            :listen: guest listens, host connects to SOCK.
  -- <guest-path> [args]    the guest command (init.krun runs it). With --kernel
                            and --rootfs it is the pinned cmdline's init,
                            /sbin/berth-init, and may be left out
  --env K=V                 guest environment (repeatable; host env is NOT passed)
  --rlimit RES=CUR:MAX      rlimit for the guest init (repeatable)
  --workdir DIR             guest working directory
  --console-output FILE     write the guest console to FILE, ignore stdin
  --tsi                     ENABLE TSI (guest AF_INET = host sockets). Builder VMs only.
  --egress-allow LIST       start the egress dialer: the guest may reach these
                            host[:port|:*] patterns (comma separated, repeatable;
                            no port = 80 and 443) through vsock 1026, at public
                            addresses only. See docs/design/microvm-egress.md
  --egress-socket SOCK      the host socket vsock 1026 is mapped to (with --egress-allow)
  --egress-max-conns N      concurrent egress tunnels (default 64)
  --log-level N             libkrun log level 0-5 (default 1)";

fn die(msg: &str) -> ! {
    eprintln!("berth-vmm: {msg}");
    exit(2);
}

fn parse(argv: Vec<String>) -> Opts {
    let mut o = Opts {
        cpus: 1,
        mem_mib: 512,
        root: None,
        root_ro: false,
        rootfs: None,
        rootfs_sha256: None,
        state: None,
        state_size_mib: 1024,
        disks: vec![],
        shares: vec![],
        vsocks: vec![],
        env: vec![],
        rlimits: vec![],
        workdir: None,
        kernel: None,
        libkrunfw_kernel: false,
        console_output: None,
        tsi: false,
        log_level: 1,
        exec: vec![],
        egress: None,
    };
    let mut egress_allow: Vec<String> = vec![];
    let mut egress_socket: Option<String> = None;
    let mut egress_max: Option<usize> = None;
    let mut args = argv.into_iter();
    while let Some(a) = args.next() {
        let mut val = || args.next().unwrap_or_else(|| die(&format!("{a} needs a value")));
        match a.as_str() {
            "--cpus" => o.cpus = val().parse().unwrap_or_else(|_| die("bad --cpus")),
            "--mem" => o.mem_mib = val().parse().unwrap_or_else(|_| die("bad --mem")),
            "--root" => o.root = Some(val()),
            "--root-ro" => o.root_ro = true,
            "--rootfs" => o.rootfs = Some(val()),
            "--rootfs-sha256" => o.rootfs_sha256 = Some(val()),
            "--state" => o.state = Some(val()),
            "--state-size" => o.state_size_mib = val().parse().unwrap_or_else(|_| die("bad --state-size")),
            "--disk" => {
                let v = val();
                let p: Vec<&str> = v.splitn(3, ':').collect();
                if p.len() < 2 {
                    die("--disk ID:IMG[:ro]");
                }
                o.disks.push(Disk { id: p[0].into(), path: p[1].into(), read_only: p.get(2) == Some(&"ro") });
            }
            "--share" => {
                let v = val();
                let p: Vec<&str> = v.splitn(3, ':').collect();
                if p.len() < 2 {
                    die("--share TAG:DIR[:ro]");
                }
                o.shares.push(Share { tag: p[0].into(), path: p[1].into(), read_only: p.get(2) == Some(&"ro") });
            }
            "--vsock" => {
                let v = val();
                let p: Vec<&str> = v.splitn(3, ':').collect();
                if p.len() < 2 {
                    die("--vsock PORT:SOCK[:listen]");
                }
                o.vsocks.push(Vsock {
                    port: p[0].parse().unwrap_or_else(|_| die("bad vsock port")),
                    path: p[1].into(),
                    listen: p.get(2) == Some(&"listen"),
                });
            }
            "--env" => o.env.push(val()),
            "--rlimit" => o.rlimits.push(val()),
            "--workdir" => o.workdir = Some(val()),
            "--kernel" => o.kernel = Some(val()),
            "--libkrunfw-kernel" => o.libkrunfw_kernel = true,
            "--console-output" => o.console_output = Some(val()),
            "--tsi" => o.tsi = true,
            "--log-level" => o.log_level = val().parse().unwrap_or_else(|_| die("bad --log-level")),
            "--egress-allow" => egress_allow.push(val()),
            "--egress-socket" => egress_socket = Some(val()),
            "--egress-max-conns" => egress_max = Some(val().parse().unwrap_or_else(|_| die("bad --egress-max-conns"))),
            "-h" | "--help" => {
                println!("{USAGE}");
                exit(0);
            }
            "--" => {
                o.exec = args.collect();
                break;
            }
            other => die(&format!("unknown option {other}\n{USAGE}")),
        }
    }
    // With the pinned kernel and a rootfs image, the kernel starts the init
    // named on the pinned command line itself; any other guest command would
    // be silently ignored, so refuse it.
    if o.kernel.is_some() && o.rootfs.is_some() {
        match o.exec.first().map(String::as_str) {
            None => o.exec = vec![run::GUEST_INIT.into()],
            Some(run::GUEST_INIT) if o.exec.len() == 1 => {}
            Some(_) => die(&format!("with --kernel and --rootfs the guest init is {} (the pinned command line); no other guest command", run::GUEST_INIT)),
        }
    }
    if o.exec.is_empty() {
        die(&format!("no guest command\n{USAGE}"));
    }
    if o.root.is_some() == o.rootfs.is_some() {
        die("need exactly one of --rootfs IMG or --root DIR");
    }
    if o.kernel.is_some() == o.libkrunfw_kernel {
        die("need exactly one of --kernel IMG (the pinned Berth kernel) or --libkrunfw-kernel (builder VMs)");
    }
    if o.state_size_mib == 0 {
        die("--state-size must be > 0");
    }
    match (egress_allow.is_empty(), egress_socket) {
        (true, None) => {}
        (false, Some(socket)) => o.egress = Some(egress_config(&egress_allow, socket.into(), egress_max)),
        _ => die("--egress-allow and --egress-socket go together"),
    }
    o
}

fn egress_dialer_only(argv: &[String]) -> ! {
    let (mut allow, mut socket, mut max) = (vec![], None, None);
    let mut args = argv.iter().cloned();
    while let Some(a) = args.next() {
        let mut val = || args.next().unwrap_or_else(|| die(&format!("{a} needs a value")));
        match a.as_str() {
            "--egress-allow" => allow.push(val()),
            "--egress-socket" => socket = Some(val()),
            "--egress-max-conns" => max = Some(val().parse().unwrap_or_else(|_| die("bad --egress-max-conns"))),
            _ => die("usage: berth-vmm egress-dialer --egress-allow LIST --egress-socket SOCK [--egress-max-conns N]"),
        }
    }
    let socket = socket.unwrap_or_else(|| die("egress-dialer: --egress-socket SOCK"));
    egress::start(&egress_config(&allow, socket.into(), max)).unwrap_or_else(|e| die(&e));
    loop {
        std::thread::park();
    }
}

/// The egress dialer's configuration, and the refusals that apply to every
/// way of starting it (the low-level flags and `run`).
pub fn egress_config(allow: &[String], socket: std::path::PathBuf, max_conns: Option<usize>) -> egress::Config {
    let allow = egress::parse_allowlist(allow).unwrap_or_else(|e| die(&e));
    if allow.is_empty() {
        die("--egress-allow names no pattern");
    }
    let max_conns = max_conns.unwrap_or(egress::DEFAULT_MAX_CONNS);
    if max_conns == 0 || max_conns > 1024 {
        die("--egress-max-conns must be 1-1024");
    }
    egress::Config { socket, allow, max_conns }
}

fn cs(s: &str) -> CString {
    CString::new(s).unwrap_or_else(|_| die("NUL in argument"))
}

fn check(what: &str, rc: i32) {
    if rc < 0 {
        die(&format!("{what} failed: errno {}", -rc));
    }
}

/// NULL-terminated char** that stays alive as long as the returned Vec does.
fn cvec(items: &[String]) -> (Vec<CString>, Vec<*const c_char>) {
    let owned: Vec<CString> = items.iter().map(|s| cs(s)).collect();
    let mut ptrs: Vec<*const c_char> = owned.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    (owned, ptrs)
}

fn json_str(s: &str) -> String {
    format!("{s:?}")
}

/// libkrun puts the guest environment on the kernel command line, after the
/// pinned one, as K="V". A `"` in a value ends the quoting, and the rest
/// becomes kernel parameters of the caller's choosing: `--env 'X=1" lsm="yama'`
/// booted with Landlock off (a later lsm= or init= wins). The kernel also
/// turns at most 31 K=V words into PID 1's environment before it panics. So:
/// names are identifiers, values have no whitespace, quotes, backslashes or
/// control characters, and the count is bounded.
fn check_guest_env(env: &[String]) {
    // The kernel's MAX_INIT_ENVS (32) less HOME and TERM, less what libkrun
    // and berth-vmm add (KRUN_INIT, KRUN_WORKDIR, PATH, BERTH_STATE_DEV) and
    // some headroom.
    const MAX_GUEST_ENV: usize = 20;
    if env.len() > MAX_GUEST_ENV {
        die(&format!("at most {MAX_GUEST_ENV} --env entries (they become kernel command line words)"));
    }
    for e in env {
        let Some((k, v)) = e.split_once('=') else { die(&format!("--env {e:?} is not K=V")) };
        let ident = !k.is_empty() && !k.starts_with(|c: char| c.is_ascii_digit()) && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
        if !ident {
            die(&format!("--env name {k:?} must be [A-Za-z_][A-Za-z0-9_]*"));
        }
        if v.bytes().any(|b| b <= b' ' || b == b'"' || b == b'\'' || b == b'\\' || b == 0x7f) {
            die(&format!("--env {k}: the value may not contain whitespace, quotes, backslashes or control characters (it goes on the kernel command line)"));
        }
    }
}

/// libkrun opens virtio-fs directories only when the guest activates the
/// device; a failure there panics a vCPU thread and leaves the VM hung. Check
/// up front (this is also where a host sandbox profile's denial shows up).
fn preflight(o: &Opts) {
    let mut dirs: Vec<&str> = o.shares.iter().map(|s| s.path.as_str()).collect();
    if let Some(r) = &o.root {
        dirs.push(r);
    }
    for d in dirs {
        if let Err(e) = std::fs::read_dir(d) {
            die(&format!("cannot open directory {d}: {e}"));
        }
    }
    for f in o.disks.iter().map(|d| d.path.as_str()) {
        if let Err(e) = std::fs::File::open(f) {
            die(&format!("cannot open disk image {f}: {e}"));
        }
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let o = match argv.first().map(String::as_str) {
        Some("run") => run::opts(&argv[1..]),
        // The dialer alone, in the foreground, with no VM: for testing the
        // broker's host path and the allowlist on the host.
        Some("egress-dialer") => egress_dialer_only(&argv[1..]),
        _ => parse(argv),
    };
    check_guest_env(&o.env);
    preflight(&o);
    // Everything that identifies what is booted is checked before libkrun sees it.
    let kernel = o.kernel.as_deref().map(|k| pins::verify_kernel(k, o.rootfs.is_some()).unwrap_or_else(|e| die(&e)));
    let rootfs = o.rootfs.as_deref().map(|r| pins::verify_rootfs(r, o.rootfs_sha256.as_deref()).unwrap_or_else(|e| die(&e)));
    // COMMAND_LINE_SIZE is 2048 on arm64; past it the kernel truncates. libkrun
    // appends each env entry as ` K="V"`, plus its own KRUN_INIT/KRUN_WORKDIR
    // (about 40 bytes; measured: 301 bytes in /proc/cmdline for a 159-byte
    // pinned line and three env entries totalling 105). 160 bytes cover
    // libkrun's words, PATH and BERTH_STATE_DEV.
    if let Some(k) = &kernel {
        let est = k.cmdline.len() + o.env.iter().map(|e| e.len() + 3).sum::<usize>() + 160;
        if est > 2048 {
            die(&format!("the guest environment does not fit on the kernel command line ({est} of 2048 bytes)"));
        }
    }
    // The pinned kernel mounts the image itself (root=/dev/vda rootfstype=erofs).
    if let (Some(_), Some(r)) = (&kernel, &rootfs) {
        if r.fstype != "erofs" {
            die(&format!("rootfs {} is {}, but the pinned kernel command line mounts an erofs root", r.path, r.fstype));
        }
    }
    let state = o.state.as_deref().map(|s| pins::open_state(s, o.state_size_mib).unwrap_or_else(|e| die(&e)));
    let mut o = o;
    if let Some(e) = &o.egress {
        if o.tsi {
            die("--egress-allow with --tsi: TSI is a second way out that nothing filters");
        }
        if o.vsocks.iter().any(|v| v.port == egress::EGRESS_PORT) {
            die(&format!("vsock port {} is the egress dialer's", egress::EGRESS_PORT));
        }
        // Listening before the guest exists: libkrun connects here when the
        // guest connects out on the port (a non-listen mapping).
        egress::start(e).unwrap_or_else(|err| die(&err));
        o.vsocks.push(Vsock { port: egress::EGRESS_PORT, path: e.socket.display().to_string(), listen: false });
    }
    unsafe {
        check("krun_init_log", krun_init_log(KRUN_LOG_TARGET_DEFAULT, o.log_level, KRUN_LOG_STYLE_AUTO, 0));
        let ctx = krun_create_ctx();
        check("krun_create_ctx", ctx);
        let ctx = ctx as u32;
        check("krun_set_vm_config", krun_set_vm_config(ctx, o.cpus, o.mem_mib));

        if let Some(k) = &kernel {
            check(
                "krun_set_kernel",
                krun_set_kernel(ctx, cs(&k.path).as_ptr(), k.format, std::ptr::null(), cs(&k.cmdline).as_ptr()),
            );
        }

        if let Some(root) = &o.root {
            if o.root_ro {
                // Same device krun_set_root creates, with the read-only flag set.
                check("krun_add_virtiofs3(root)", krun_add_virtiofs3(ctx, cs("/dev/root").as_ptr(), cs(root).as_ptr(), 0, true));
            } else {
                check("krun_set_root", krun_set_root(ctx, cs(root).as_ptr()));
            }
        }
        // Disks are attached in order: vda, vdb, ...  The guest contract
        // (docs/design/microvm-image.md): vda = rootfs, vdb = state.
        let mut next_dev = b'a';
        let mut dev = || {
            let d = format!("/dev/vd{}", next_dev as char);
            next_dev += 1;
            d
        };
        if let Some(r) = &rootfs {
            let d = dev();
            check("krun_add_disk(rootfs)", krun_add_disk(ctx, cs("rootfs").as_ptr(), cs(&r.path).as_ptr(), true));
            if kernel.is_none() {
                // libkrunfw's kernel (not a sandbox): libkrun boots init.krun
                // from a dummy virtio-fs root, then mounts this device
                // read-only and switches to it. The pinned kernel's command
                // line mounts it directly instead (root=/dev/vda).
                check(
                    "krun_set_root_disk_remount",
                    krun_set_root_disk_remount(ctx, cs(&d).as_ptr(), cs(r.fstype).as_ptr(), cs("ro").as_ptr()),
                );
            }
        }
        let mut guest_env: Vec<String> = vec![];
        if let Some(s) = &state {
            let d = dev();
            check("krun_add_disk(state)", krun_add_disk(ctx, cs("state").as_ptr(), cs(&s.path).as_ptr(), false));
            guest_env.push(format!("BERTH_STATE_DEV={d}"));
        }
        for d in &o.disks {
            check("krun_add_disk", krun_add_disk(ctx, cs(&d.id).as_ptr(), cs(&d.path).as_ptr(), d.read_only));
        }
        for s in &o.shares {
            check("krun_add_virtiofs3", krun_add_virtiofs3(ctx, cs(&s.tag).as_ptr(), cs(&s.path).as_ptr(), 0, s.read_only));
        }

        // Networking. libkrun's implicit vsock device turns TSI on whenever no NIC is
        // added, which makes the guest's AF_INET sockets the VMM's own host sockets.
        // Always replace it with an explicit device whose TSI mask we choose. No
        // virtio-net device is ever added.
        check("krun_disable_implicit_vsock", krun_disable_implicit_vsock(ctx));
        let tsi_mask = if o.tsi { KRUN_TSI_HIJACK_INET } else { 0 };
        check("krun_add_vsock", krun_add_vsock(ctx, tsi_mask));
        for v in &o.vsocks {
            check("krun_add_vsock_port2", krun_add_vsock_port2(ctx, v.port, cs(&v.path).as_ptr(), v.listen));
        }

        if !o.rlimits.is_empty() {
            let (_keep, ptrs) = cvec(&o.rlimits);
            check("krun_set_rlimits", krun_set_rlimits(ctx, ptrs.as_ptr()));
        }
        if let Some(w) = &o.workdir {
            check("krun_set_workdir", krun_set_workdir(ctx, cs(w).as_ptr()));
        }
        if let Some(f) = &o.console_output {
            check("krun_set_console_output", krun_set_console_output(ctx, cs(f).as_ptr()));
        }

        // Never leak the host environment into the guest: pass an explicit envp.
        let mut env = vec!["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".to_string()];
        env.extend(guest_env);
        env.extend(o.env.iter().cloned());
        let (_ek, envp) = cvec(&env);
        let (_ak, argv) = cvec(&o.exec[1..]);
        check("krun_set_exec", krun_set_exec(ctx, cs(&o.exec[0]).as_ptr(), argv.as_ptr(), envp.as_ptr()));

        // One structured line describing what this VM was given; doctor/attestation
        // would record the same facts.
        let vs: Vec<String> = o
            .vsocks
            .iter()
            .map(|v| format!("{{\"port\":{},\"path\":{},\"listen\":{}}}", v.port, json_str(&v.path), v.listen))
            .collect();
        let sh: Vec<String> = o
            .shares
            .iter()
            .map(|s| format!("{{\"tag\":{},\"path\":{},\"readOnly\":{}}}", json_str(&s.tag), json_str(&s.path), s.read_only))
            .collect();
        eprintln!(
            "{{\"source\":\"berth-vmm\",\"event\":\"vm_config\",\"pid\":{},\"cpus\":{},\"memMiB\":{},\"tsi\":{},\"nics\":0,\"root\":{},\"rootReadOnly\":{},\"rootfs\":{},\"state\":{},\"kernel\":{},\"vsock\":[{}],\"shares\":[{}]}}",
            std::process::id(),
            o.cpus,
            o.mem_mib,
            o.tsi,
            json_str(o.root.as_deref().unwrap_or("")),
            o.root_ro || rootfs.is_some(),
            json_str(o.rootfs.as_deref().unwrap_or("")),
            json_str(o.state.as_deref().unwrap_or("")),
            json_str(o.kernel.as_deref().unwrap_or("libkrunfw")),
            vs.join(","),
            sh.join(",")
        );
        // The measurement line: what was booted, by hash. Attestation reads this
        // (a later step signs it); null means "not pinned" and must be reported
        // as such, never as a pass.
        let kernel_json = kernel.as_ref().map_or("null".to_string(), |k| {
            format!(
                "{{\"sha256\":{},\"pinned\":true,\"linux\":{},\"configSha256\":{},\"cmdline\":{},\"hashMs\":{}}}",
                json_str(&k.sha256),
                json_str(&k.linux),
                json_str(&k.config_sha256),
                json_str(&k.cmdline),
                k.hash_ms
            )
        });
        let rootfs_json = rootfs.as_ref().map_or("null".to_string(), |r| {
            format!(
                "{{\"sha256\":{},\"pinned\":{},\"fstype\":{},\"readOnly\":true,\"hashMs\":{}}}",
                json_str(&r.sha256),
                r.sha256 == pins::rootfs_pin(),
                json_str(r.fstype),
                r.hash_ms
            )
        });
        let state_json = state.as_ref().map_or("null".to_string(), |s| {
            format!(
                "{{\"chunkedSha256\":{},\"chunkBytes\":{},\"path\":{},\"sizeBytes\":{},\"created\":{},\"restoredBytes\":{},\"hashMs\":{},\"hashedBytes\":{}}}",
                json_str(&s.digest),
                pins::STATE_DIGEST_CHUNK,
                json_str(&s.path),
                s.size,
                s.created,
                s.restored,
                s.hash_ms,
                s.hashed_bytes
            )
        });
        eprintln!(
            "{{\"source\":\"berth-vmm\",\"event\":\"measurements\",\"kernel\":{kernel_json},\"rootfs\":{rootfs_json},\"state\":{state_json}}}"
        );

        // Only returns on a configuration error.
        let rc = krun_start_enter(ctx);
        die(&format!("krun_start_enter failed: errno {}", -rc));
    }
}
