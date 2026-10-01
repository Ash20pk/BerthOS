// berth-vmm: spike launcher that runs one Berth sandbox inside a libkrun microVM.
//
// One process per VM (HVF allows one VM per process). The VM gets:
//   - a fixed vCPU count and RAM size,
//   - a root filesystem (a host directory over virtio-fs, or an ext4 disk image),
//   - NO network interface and TSI explicitly disabled, unless --tsi is passed
//     (only the rootfs/kernel *builder* VMs use --tsi, to reach the Alpine mirror),
//   - vsock ports mapped to host Unix sockets (the only way in or out),
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
    root_disk: Option<String>,
    root_disk_fstype: String,
    disks: Vec<Disk>,
    shares: Vec<Share>,
    vsocks: Vec<Vsock>,
    env: Vec<String>,
    rlimits: Vec<String>,
    workdir: Option<String>,
    kernel: Option<String>,
    kernel_format: u32,
    cmdline: Option<String>,
    console_output: Option<String>,
    tsi: bool,
    log_level: u32,
    exec: Vec<String>,
}

const USAGE: &str = "usage: berth-vmm [options] -- <guest-path> [args...]

  --cpus N                  vCPUs (default 1)
  --mem MIB                 guest RAM in MiB (default 512)
  --root DIR                root filesystem: host directory over virtio-fs
  --root-ro                 expose --root read-only (guest needs tmpfs for writes)
  --root-disk IMG           root filesystem: raw ext4 image (becomes /dev/vda)
  --disk ID:IMG[:ro]        extra raw disk (repeatable; /dev/vdb, ...)
  --share TAG:DIR[:ro]      extra virtio-fs share (repeatable)
  --vsock PORT:SOCK[:listen]  map guest vsock PORT to host unix socket SOCK.
                            default: guest connects out, host listens on SOCK.
                            :listen: guest listens, host connects to SOCK.
  --env K=V                 guest environment (repeatable; host env is NOT passed)
  --rlimit RES=CUR:MAX      rlimit for the guest init (repeatable)
  --workdir DIR             guest working directory
  --kernel IMG              boot this kernel instead of libkrunfw's
  --kernel-format N         0 raw, 1 elf, 4 Image.gz (default 0)
  --cmdline STR             kernel cmdline (with --kernel)
  --console-output FILE     write the guest console to FILE, ignore stdin
  --tsi                     ENABLE TSI (guest AF_INET = host sockets). Builder VMs only.
  --log-level N             libkrun log level 0-5 (default 1)";

fn die(msg: &str) -> ! {
    eprintln!("berth-vmm: {msg}");
    exit(2);
}

fn parse() -> Opts {
    let mut o = Opts {
        cpus: 1,
        mem_mib: 512,
        root: None,
        root_ro: false,
        root_disk: None,
        root_disk_fstype: "ext4".into(),
        disks: vec![],
        shares: vec![],
        vsocks: vec![],
        env: vec![],
        rlimits: vec![],
        workdir: None,
        kernel: None,
        kernel_format: 0,
        cmdline: None,
        console_output: None,
        tsi: false,
        log_level: 1,
        exec: vec![],
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = || args.next().unwrap_or_else(|| die(&format!("{a} needs a value")));
        match a.as_str() {
            "--cpus" => o.cpus = val().parse().unwrap_or_else(|_| die("bad --cpus")),
            "--mem" => o.mem_mib = val().parse().unwrap_or_else(|_| die("bad --mem")),
            "--root" => o.root = Some(val()),
            "--root-ro" => o.root_ro = true,
            "--root-disk" => o.root_disk = Some(val()),
            "--root-disk-fstype" => o.root_disk_fstype = val(),
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
            "--kernel-format" => o.kernel_format = val().parse().unwrap_or_else(|_| die("bad --kernel-format")),
            "--cmdline" => o.cmdline = Some(val()),
            "--console-output" => o.console_output = Some(val()),
            "--tsi" => o.tsi = true,
            "--log-level" => o.log_level = val().parse().unwrap_or_else(|_| die("bad --log-level")),
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
    if o.exec.is_empty() {
        die(&format!("no guest command\n{USAGE}"));
    }
    if o.root.is_none() && o.root_disk.is_none() {
        die("need --root or --root-disk");
    }
    o
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
    for f in o.disks.iter().map(|d| d.path.as_str()).chain(o.root_disk.as_deref()) {
        if let Err(e) = std::fs::File::open(f) {
            die(&format!("cannot open disk image {f}: {e}"));
        }
    }
}

fn main() {
    let o = parse();
    preflight(&o);
    unsafe {
        check("krun_init_log", krun_init_log(KRUN_LOG_TARGET_DEFAULT, o.log_level, KRUN_LOG_STYLE_AUTO, 0));
        let ctx = krun_create_ctx();
        check("krun_create_ctx", ctx);
        let ctx = ctx as u32;
        check("krun_set_vm_config", krun_set_vm_config(ctx, o.cpus, o.mem_mib));

        if let Some(k) = &o.kernel {
            let cmdline = o.cmdline.as_deref().map(cs);
            check(
                "krun_set_kernel",
                krun_set_kernel(
                    ctx,
                    cs(k).as_ptr(),
                    o.kernel_format,
                    std::ptr::null(),
                    cmdline.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
                ),
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
        // Disks are attached in order: vda, vdb, ...  A root disk goes first.
        if let Some(img) = &o.root_disk {
            check("krun_add_disk(root)", krun_add_disk(ctx, cs("root").as_ptr(), cs(img).as_ptr(), false));
            check(
                "krun_set_root_disk_remount",
                krun_set_root_disk_remount(ctx, cs("/dev/vda").as_ptr(), cs(&o.root_disk_fstype).as_ptr(), std::ptr::null()),
            );
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
            "{{\"source\":\"berth-vmm\",\"event\":\"vm_config\",\"pid\":{},\"cpus\":{},\"memMiB\":{},\"tsi\":{},\"nics\":0,\"root\":{},\"rootReadOnly\":{},\"rootDisk\":{},\"kernel\":{},\"vsock\":[{}],\"shares\":[{}]}}",
            std::process::id(),
            o.cpus,
            o.mem_mib,
            o.tsi,
            json_str(o.root.as_deref().unwrap_or("")),
            o.root_ro,
            json_str(o.root_disk.as_deref().unwrap_or("")),
            json_str(o.kernel.as_deref().unwrap_or("libkrunfw")),
            vs.join(","),
            sh.join(",")
        );

        // Only returns on a configuration error.
        let rc = krun_start_enter(ctx);
        die(&format!("krun_start_enter failed: errno {}", -rc));
    }
}
