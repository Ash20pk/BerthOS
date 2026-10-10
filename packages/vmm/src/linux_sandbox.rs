// berth-vmm's own wall on Linux: the sandbox.rs plan, enforced with Landlock
// (what it may open) and a seccomp filter (what it may never do), the
// counterpart of the Seatbelt profile on macOS.
//
//   Landlock   every filesystem right is handled: the plan's paths get theirs,
//              plus what libkrun still opens once the VM runs (/dev/kvm, its
//              own /proc/<pid> for virtio-fs's fd reopening, the CPU list in
//              /sys) and the shared libraries; nothing else of the user's
//              opens. TCP (ABI 4, Linux 6.7): bind never; connect only with the
//              egress dialer, which checks its allowlist itself (Landlock, like
//              Seatbelt, can't filter by host name). Abstract Unix sockets and
//              signals to other processes are scoped off (ABI 6, Linux 6.12).
//   seccomp    a deny list, EPERM: exec, ptrace and process_vm_*, mounts and
//              namespaces, module and kexec loading, bpf, perf, keyrings,
//              userfaultfd, io_uring. Everything else is allowed: a VMM's
//              normal syscalls (KVM ioctls, eventfds, threads) stay as libkrun
//              needs them. Applied to every thread (TSYNC).
//
// Fails closed: no Landlock at all, or a rule that doesn't apply, stops the
// boot. An older kernel's Landlock that lacks the TCP or scope rights is used
// for what it has, and the host_sandbox line says what was left out.
use super::Plan;
use std::ffi::CString;
use std::os::raw::{c_int, c_long, c_uint, c_ulong, c_void};

extern "C" {
    fn syscall(n: c_long, ...) -> c_long;
    fn prctl(option: c_int, ...) -> c_int;
    fn open(path: *const i8, flags: c_int, ...) -> c_int;
    fn close(fd: c_int) -> c_int;
    fn __errno_location() -> *mut c_int;
}

const SYS_LANDLOCK_CREATE_RULESET: c_long = 444;
const SYS_LANDLOCK_ADD_RULE: c_long = 445;
const SYS_LANDLOCK_RESTRICT_SELF: c_long = 446;
#[cfg(target_arch = "x86_64")]
const SYS_SECCOMP: c_long = 317;
#[cfg(target_arch = "aarch64")]
const SYS_SECCOMP: c_long = 277;

const O_PATH: c_int = 0o10000000;
const O_CLOEXEC: c_int = 0o2000000;
const PR_SET_NO_NEW_PRIVS: c_int = 38;

// Landlock filesystem rights, by the ABI that introduced them.
const FS_EXECUTE: u64 = 1 << 0;
const FS_WRITE_FILE: u64 = 1 << 1;
const FS_READ_FILE: u64 = 1 << 2;
const FS_READ_DIR: u64 = 1 << 3;
const FS_ABI1_ALL: u64 = (1 << 13) - 1; // EXECUTE ..= MAKE_SYM
const FS_REFER: u64 = 1 << 13; // ABI 2
const FS_TRUNCATE: u64 = 1 << 14; // ABI 3
const FS_IOCTL_DEV: u64 = 1 << 15; // ABI 5
/// The rights a rule on a file (not a directory) may carry.
const FS_FILE_RIGHTS: u64 = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV;
const NET_BIND_TCP: u64 = 1 << 0; // ABI 4
const NET_CONNECT_TCP: u64 = 1 << 1;
const SCOPE_ABSTRACT_UNIX_SOCKET: u64 = 1 << 0; // ABI 6
const SCOPE_SIGNAL: u64 = 1 << 1;
const RULE_PATH_BENEATH: c_int = 1;

#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
    handled_access_net: u64,
    scoped: u64,
}

#[repr(C, packed)]
struct PathBeneath {
    allowed_access: u64,
    parent_fd: i32,
}

fn errno() -> c_int {
    unsafe { *__errno_location() }
}

/// What was applied, for the host_sandbox line.
#[derive(Debug)]
pub struct Applied {
    pub abi: i64,
    pub tcp_rules: bool,
    pub scoped: bool,
    pub seccomp: bool,
    /// Paths the plan or the baseline named that don't exist here (no rule).
    pub missing: Vec<String>,
}

/// The Landlock ABI the running kernel offers: 0 when it has none (not built
/// in, or not in the active LSM list).
pub fn landlock_abi() -> i64 {
    let r = unsafe { syscall(SYS_LANDLOCK_CREATE_RULESET, std::ptr::null::<c_void>(), 0usize, 1 as c_uint) };
    if r < 0 {
        0
    } else {
        r as i64
    }
}

/// Paths a running libkrun and the Rust/glibc runtime still need, by rights.
fn baseline(p: &Plan, abi: i64) -> Vec<(String, u64)> {
    let read = FS_READ_FILE | FS_READ_DIR;
    let libs = read | FS_EXECUTE;
    let mut v: Vec<(String, u64)> = ["/lib", "/lib64", "/usr/lib", "/usr/lib64", "/usr/local/lib", "/usr/local/lib64"].iter().map(|d| (d.to_string(), libs)).collect();
    // A bundled libkrun next to berth-vmm (RUNPATH $ORIGIN).
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.display().to_string())) {
        v.push((dir, libs));
    }
    v.push(("/etc/ld.so.cache".into(), FS_READ_FILE));
    // virtio-fs reopens share files through /proc/self/fd; the rule binds to
    // what /proc/self resolves to now, this process's own directory.
    v.push((format!("/proc/{}", std::process::id()), read));
    v.push(("/sys/devices/system/cpu".into(), read));
    v.push(("/dev/null".into(), FS_READ_FILE | FS_WRITE_FILE));
    v.push(("/dev/urandom".into(), FS_READ_FILE));
    v.push(("/dev/kvm".into(), FS_READ_FILE | FS_WRITE_FILE | if abi >= 5 { FS_IOCTL_DEV } else { 0 }));
    if p.egress {
        // getaddrinfo: the resolver's configuration (resolv.conf is often a
        // link into /run; a rule binds to the file it resolves to).
        for f in ["/etc/hosts", "/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/gai.conf", "/etc/host.conf"] {
            v.push((f.into(), FS_READ_FILE));
        }
    }
    v
}

fn handled_fs(abi: i64) -> u64 {
    let mut h = FS_ABI1_ALL;
    if abi >= 2 {
        h |= FS_REFER;
    }
    if abi >= 3 {
        h |= FS_TRUNCATE;
    }
    if abi >= 5 {
        h |= FS_IOCTL_DEV;
    }
    h
}

/// The rule set for a plan, as (path, rights), rights already cut to what the
/// kernel handles and to what a file rule may carry.
fn rules(p: &Plan, abi: i64) -> Vec<(String, u64)> {
    let all = handled_fs(abi);
    let read = FS_READ_FILE | FS_READ_DIR;
    let mut v = baseline(p, abi);
    v.extend(p.read_files.iter().map(|f| (f.clone(), FS_READ_FILE)));
    v.extend(p.read_dirs.iter().map(|d| (d.clone(), read)));
    v.extend(p.write_files.iter().map(|f| (f.clone(), FS_READ_FILE | FS_WRITE_FILE | FS_TRUNCATE)));
    v.extend(p.write_dirs.iter().map(|d| (d.clone(), all & !FS_EXECUTE)));
    v.into_iter().map(|(path, r)| (path, r & all)).collect()
}

/// Opens `path` O_PATH and adds a path-beneath rule for it. Ok(false) when it
/// doesn't exist.
fn add_path(ruleset: c_int, path: &str, rights: u64) -> Result<bool, String> {
    let c = CString::new(path).map_err(|_| format!("{path}: NUL in path"))?;
    let fd = unsafe { open(c.as_ptr(), O_PATH | O_CLOEXEC) };
    if fd < 0 {
        let e = errno();
        return if e == 2 || e == 20 { Ok(false) } else { Err(format!("{path}: open: errno {e}")) };
    }
    let is_dir = std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false);
    let rights = if is_dir { rights } else { rights & FS_FILE_RIGHTS };
    let attr = PathBeneath { allowed_access: rights, parent_fd: fd };
    let r = unsafe { syscall(SYS_LANDLOCK_ADD_RULE, ruleset, RULE_PATH_BENEATH, &attr as *const PathBeneath, 0 as c_uint) };
    let e = errno();
    unsafe { close(fd) };
    if r < 0 {
        return Err(format!("{path}: landlock_add_rule: errno {e}"));
    }
    Ok(true)
}

/// The threads of this process. Landlock binds only the calling thread and
/// what it starts later, so confinement must happen while there is one.
fn thread_count() -> usize {
    std::fs::read_dir("/proc/self/task").map(|d| d.count()).unwrap_or(0)
}

/// Confines this process, for good, with `p`. Must be called while it is
/// single-threaded.
pub fn apply_plan(p: &Plan) -> Result<Applied, String> {
    let threads = thread_count();
    if threads != 1 {
        return Err(format!("{threads} threads are running; berth-vmm confines itself before it starts any"));
    }
    let abi = landlock_abi();
    if abi < 1 {
        return Err("this kernel has no Landlock (CONFIG_SECURITY_LANDLOCK, and landlock in the lsm= list)".into());
    }
    let tcp_rules = abi >= 4;
    let scoped = abi >= 6;
    let attr = RulesetAttr {
        handled_access_fs: handled_fs(abi),
        // Connect is handled (so refused) only without the egress dialer.
        handled_access_net: if tcp_rules { NET_BIND_TCP | if p.egress { 0 } else { NET_CONNECT_TCP } } else { 0 },
        scoped: if scoped { SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL } else { 0 },
    };
    // The struct's size tells the kernel which fields this caller knows.
    let size = if scoped { 24 } else if tcp_rules { 16 } else { 8 };
    let ruleset = unsafe { syscall(SYS_LANDLOCK_CREATE_RULESET, &attr as *const RulesetAttr, size as usize, 0 as c_uint) };
    if ruleset < 0 {
        return Err(format!("landlock_create_ruleset: errno {}", errno()));
    }
    let ruleset = ruleset as c_int;
    let mut missing = vec![];
    let result = (|| {
        for (path, rights) in rules(p, abi) {
            if !add_path(ruleset, &path, rights)? {
                missing.push(path);
            }
        }
        if unsafe { prctl(PR_SET_NO_NEW_PRIVS, 1 as c_ulong, 0 as c_ulong, 0 as c_ulong, 0 as c_ulong) } != 0 {
            return Err(format!("prctl(PR_SET_NO_NEW_PRIVS): errno {}", errno()));
        }
        if unsafe { syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset, 0 as c_uint) } != 0 {
            return Err(format!("landlock_restrict_self: errno {}", errno()));
        }
        Ok(())
    })();
    unsafe { close(ruleset) };
    result?;
    seccomp_deny()?;
    Ok(Applied { abi, tcp_rules, scoped, seccomp: true, missing })
}

// --- seccomp -----------------------------------------------------------------

#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH: u32 = 0xC000_003E;
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH: u32 = 0xC000_00B7;

/// Syscalls berth-vmm never makes once confined, by number on this
/// architecture: (name, number).
#[cfg(target_arch = "x86_64")]
pub const DENIED: &[(&str, u32)] = &[
    ("execve", 59), ("execveat", 322), ("ptrace", 101), ("process_vm_readv", 310), ("process_vm_writev", 311),
    ("mount", 165), ("umount2", 166), ("pivot_root", 155), ("chroot", 161), ("unshare", 272), ("setns", 308),
    ("open_tree", 428), ("move_mount", 429), ("fsopen", 430), ("fsconfig", 431), ("fsmount", 432), ("fspick", 433), ("mount_setattr", 442),
    ("init_module", 175), ("finit_module", 313), ("delete_module", 176), ("kexec_load", 246), ("kexec_file_load", 320),
    ("bpf", 321), ("perf_event_open", 298), ("keyctl", 250), ("add_key", 248), ("request_key", 249),
    ("name_to_handle_at", 303), ("open_by_handle_at", 304), ("userfaultfd", 323),
    ("io_uring_setup", 425), ("io_uring_enter", 426), ("io_uring_register", 427),
    ("swapon", 167), ("swapoff", 168), ("reboot", 169), ("syslog", 103), ("acct", 163),
];
#[cfg(target_arch = "aarch64")]
pub const DENIED: &[(&str, u32)] = &[
    ("execve", 221), ("execveat", 281), ("ptrace", 117), ("process_vm_readv", 270), ("process_vm_writev", 271),
    ("mount", 40), ("umount2", 39), ("pivot_root", 41), ("chroot", 51), ("unshare", 97), ("setns", 268),
    ("open_tree", 428), ("move_mount", 429), ("fsopen", 430), ("fsconfig", 431), ("fsmount", 432), ("fspick", 433), ("mount_setattr", 442),
    ("init_module", 105), ("finit_module", 273), ("delete_module", 106), ("kexec_load", 104), ("kexec_file_load", 294),
    ("bpf", 280), ("perf_event_open", 241), ("keyctl", 219), ("add_key", 217), ("request_key", 218),
    ("name_to_handle_at", 264), ("open_by_handle_at", 265), ("userfaultfd", 282),
    ("io_uring_setup", 425), ("io_uring_enter", 426), ("io_uring_register", 427),
    ("swapon", 224), ("swapoff", 225), ("reboot", 142), ("syslog", 116), ("acct", 89),
];

#[repr(C)]
#[derive(Clone, Copy)]
struct SockFilter {
    code: u16,
    jt: u8,
    jf: u8,
    k: u32,
}

#[repr(C)]
struct SockFprog {
    len: u16,
    filter: *const SockFilter,
}

const BPF_LD_W_ABS: u16 = 0x20;
const BPF_JEQ_K: u16 = 0x15;
const BPF_JGE_K: u16 = 0x35;
const BPF_RET_K: u16 = 0x06;
const RET_ALLOW: u32 = 0x7fff_0000;
const RET_KILL_PROCESS: u32 = 0x8000_0000;
const RET_ERRNO_EPERM: u32 = 0x0005_0000 | 1;
/// x32 syscalls on x86_64 carry this bit; none is ever wanted.
const X32_BIT: u32 = 0x4000_0000;

fn stmt(code: u16, k: u32) -> SockFilter {
    SockFilter { code, jt: 0, jf: 0, k }
}

/// arch check, then one compare per denied number; anything else is allowed.
fn program() -> Vec<SockFilter> {
    let mut f = vec![
        stmt(BPF_LD_W_ABS, 4), // seccomp_data.arch
        SockFilter { code: BPF_JEQ_K, jt: 1, jf: 0, k: AUDIT_ARCH },
        stmt(BPF_RET_K, RET_KILL_PROCESS),
        stmt(BPF_LD_W_ABS, 0), // seccomp_data.nr
    ];
    if cfg!(target_arch = "x86_64") {
        f.push(SockFilter { code: BPF_JGE_K, jt: 0, jf: 1, k: X32_BIT });
        f.push(stmt(BPF_RET_K, RET_ERRNO_EPERM));
    }
    for (_, nr) in DENIED {
        f.push(SockFilter { code: BPF_JEQ_K, jt: 0, jf: 1, k: *nr });
        f.push(stmt(BPF_RET_K, RET_ERRNO_EPERM));
    }
    f.push(stmt(BPF_RET_K, RET_ALLOW));
    f
}

fn seccomp_deny() -> Result<(), String> {
    const SECCOMP_SET_MODE_FILTER: c_uint = 1;
    const SECCOMP_FILTER_FLAG_TSYNC: c_uint = 1;
    let f = program();
    let prog = SockFprog { len: f.len() as u16, filter: f.as_ptr() };
    let r = unsafe { syscall(SYS_SECCOMP, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC, &prog as *const SockFprog) };
    if r != 0 {
        return Err(format!("seccomp(SET_MODE_FILTER, TSYNC): errno {}", errno()));
    }
    Ok(())
}

/// For --host-sandbox-probe: what an exec attempt gets once confined. The path
/// doesn't exist, so an unfiltered execve fails with ENOENT and never runs
/// anything; the filter answers EPERM first.
pub fn probe_exec() -> String {
    let path = CString::new("/nonexistent/berth-vmm-exec-probe").unwrap();
    let argv: [*const i8; 1] = [std::ptr::null()];
    let nr = DENIED.iter().find(|(n, _)| *n == "execve").map(|(_, nr)| *nr as c_long).unwrap();
    let r = unsafe { syscall(nr, path.as_ptr(), argv.as_ptr(), argv.as_ptr()) };
    match (r, errno()) {
        (0, _) => "ok".into(),
        (_, 1) => "EPERM".into(),
        (_, 2) => "ENOENT".into(),
        (_, e) => format!("errno {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(egress: bool) -> Plan {
        Plan {
            read_files: vec!["/v/kernel/Image".into()],
            read_dirs: vec!["/v/apps/notes".into()],
            write_files: vec!["/v/state/notes.img".into()],
            write_dirs: vec!["/r/run".into()],
            socket_dir: "/r/run".into(),
            egress,
        }
    }

    #[test]
    fn rules_grant_the_plan_and_no_more() {
        let r = rules(&plan(false), 6);
        let get = |p: &str| r.iter().find(|(x, _)| x == p).map(|(_, a)| *a);
        assert_eq!(get("/v/kernel/Image"), Some(FS_READ_FILE));
        assert_eq!(get("/v/apps/notes"), Some(FS_READ_FILE | FS_READ_DIR));
        assert_eq!(get("/v/state/notes.img"), Some(FS_READ_FILE | FS_WRITE_FILE | FS_TRUNCATE));
        let run = get("/r/run").unwrap();
        assert!(run & FS_WRITE_FILE != 0 && run & (1 << 9) != 0, "the run directory: write and make sockets");
        assert_eq!(run & FS_EXECUTE, 0, "nothing in the run directory executes");
        assert_eq!(get("/dev/kvm"), Some(FS_READ_FILE | FS_WRITE_FILE | FS_IOCTL_DEV));
        assert!(get("/etc/resolv.conf").is_none(), "no resolver files without the egress dialer");
        assert!(rules(&plan(true), 6).iter().any(|(p, _)| p == "/etc/resolv.conf"));
        // An older kernel: rights it doesn't know are dropped, not refused.
        let old = rules(&plan(false), 1);
        assert!(old.iter().all(|(_, a)| a & !FS_ABI1_ALL == 0));
    }

    #[test]
    fn the_filter_denies_exec_and_allows_the_rest() {
        let f = program();
        assert_eq!(f.last().unwrap().k, RET_ALLOW);
        assert!(DENIED.iter().any(|(n, _)| *n == "execve"));
        // Every denied number is followed by an EPERM return.
        for (_, nr) in DENIED {
            let i = f.iter().position(|s| s.code == BPF_JEQ_K && s.k == *nr).expect("compared");
            assert_eq!(f[i + 1].k, RET_ERRNO_EPERM);
        }
        assert!(f.len() < 256);
    }
}
