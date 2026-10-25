//! Thin wrappers over the system calls PID 1 needs: mounts, signals, vsock,
//! the loopback interface, and power off.

use std::ffi::CString;
use std::io;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::time::Duration;

fn cstr(s: &str) -> CString {
    CString::new(s).expect("NUL in path")
}

fn errno() -> io::Error {
    io::Error::last_os_error()
}

/// Whether `path` is a mount point, from /proc/self/mountinfo.
pub fn is_mounted(path: &str) -> bool {
    std::fs::read_to_string("/proc/self/mountinfo")
        .map(|m| m.lines().any(|l| l.split(' ').nth(4) == Some(path)))
        .unwrap_or(false)
}

/// The filesystem's own options for the mount at `path` (mountinfo's last
/// field, e.g. cgroup2's "rw,nsdelegate,favordynmods").
pub fn super_options(path: &str) -> Option<String> {
    let m = std::fs::read_to_string("/proc/self/mountinfo").ok()?;
    // The last mount at `path` is the visible one.
    let line = m.lines().filter(|l| l.split(' ').nth(4) == Some(path)).last()?;
    let (_, tail) = line.split_once(" - ")?;
    tail.split(' ').nth(2).map(String::from)
}

pub fn mount(source: &str, target: &str, fstype: &str, flags: libc::c_ulong, data: Option<&str>) -> io::Result<()> {
    let (s, t, f) = (cstr(source), cstr(target), cstr(fstype));
    let d = data.map(cstr);
    let rc = unsafe {
        libc::mount(s.as_ptr(), t.as_ptr(), f.as_ptr(), flags, d.as_ref().map_or(std::ptr::null(), |d| d.as_ptr().cast()))
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(errno())
    }
}

/// Mount unless something is already mounted there (libkrun's init.krun, when
/// it is what exec'd us, has already mounted /proc, /sys and /dev).
pub fn ensure_mount(source: &str, target: &str, fstype: &str, flags: libc::c_ulong, data: Option<&str>) -> io::Result<bool> {
    if is_mounted(target) {
        return Ok(false);
    }
    let _ = std::fs::create_dir_all(target);
    mount(source, target, fstype, flags, data).map(|_| true)
}

pub fn bind(source: &str, target: &str) -> io::Result<()> {
    mount(source, target, "", libc::MS_BIND, None)
}

pub fn umount(target: &str) -> io::Result<()> {
    let t = cstr(target);
    if unsafe { libc::umount2(t.as_ptr(), 0) } == 0 {
        return Ok(());
    }
    let first = errno();
    // Busy (a process we could not kill, a lazy fd): detach instead, so the
    // remaining mounts still come down in order.
    if unsafe { libc::umount2(t.as_ptr(), libc::MNT_DETACH) } == 0 {
        return Err(io::Error::new(first.kind(), format!("{first}; detached instead")));
    }
    Err(first)
}

/// Every mount point below `/`, deepest first, from mountinfo.
pub fn mount_points() -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_to_string("/proc/self/mountinfo")
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split(' ').nth(4).map(String::from))
        .filter(|p| p != "/")
        .collect();
    // mountinfo lists mounts in the order they were made; reverse it so
    // children come down before parents.
    v.reverse();
    v
}

pub fn sethostname(name: &str) {
    unsafe {
        libc::sethostname(name.as_ptr().cast(), name.len());
    }
}

/// Brings `lo` up (127.0.0.1 is assigned by the kernel when the interface
/// comes up). Without it the in-guest brokers and loopback RPC have nowhere
/// to listen; libkrun's init.krun does the same.
pub fn loopback_up() -> io::Result<()> {
    unsafe {
        let fd = libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0);
        if fd < 0 {
            return Err(errno());
        }
        let fd = OwnedFd::from_raw_fd(fd);
        let mut ifr: libc::ifreq = std::mem::zeroed();
        for (i, b) in b"lo".iter().enumerate() {
            ifr.ifr_name[i] = *b as libc::c_char;
        }
        use std::os::fd::AsRawFd;
        if libc::ioctl(fd.as_raw_fd(), libc::SIOCGIFFLAGS as _, &mut ifr) < 0 {
            return Err(errno());
        }
        ifr.ifr_ifru.ifru_flags |= (libc::IFF_UP | libc::IFF_RUNNING) as libc::c_short;
        if libc::ioctl(fd.as_raw_fd(), libc::SIOCSIFFLAGS as _, &ifr) < 0 {
            return Err(errno());
        }
    }
    Ok(())
}

/// Signals PID 1 handles synchronously, on the main thread. Blocked before
/// any thread is started so every thread inherits the mask and none of them
/// takes the signal instead.
pub fn handled_signals() -> libc::sigset_t {
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for s in [libc::SIGCHLD, libc::SIGTERM, libc::SIGINT, libc::SIGHUP, libc::SIGPWR, libc::SIGUSR1, libc::SIGUSR2] {
            libc::sigaddset(&mut set, s);
        }
        set
    }
}

pub fn block_signals(set: &libc::sigset_t) {
    unsafe {
        libc::pthread_sigmask(libc::SIG_BLOCK, set, std::ptr::null_mut());
    }
}

/// Waits up to `timeout` for one of `set`. None on timeout.
pub fn wait_signal(set: &libc::sigset_t, timeout: Duration) -> Option<i32> {
    let ts = libc::timespec { tv_sec: timeout.as_secs() as _, tv_nsec: timeout.subsec_nanos() as _ };
    let rc = unsafe { libc::sigtimedwait(set, std::ptr::null_mut(), &ts) };
    (rc > 0).then_some(rc)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Code(i32),
    Signal(i32),
}

impl Exit {
    pub fn json(&self) -> serde_json::Value {
        match self {
            Exit::Code(c) => serde_json::json!({ "code": c }),
            Exit::Signal(s) => serde_json::json!({ "signal": s }),
        }
    }
}

/// Reaps every child that has exited. PID 1 inherits every orphan in the
/// guest, so this is called on each SIGCHLD and periodically.
pub fn reap() -> Vec<(i32, Exit)> {
    let mut out = Vec::new();
    loop {
        let mut status = 0;
        let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if pid <= 0 {
            break;
        }
        let exit = if libc::WIFEXITED(status) {
            Exit::Code(libc::WEXITSTATUS(status))
        } else {
            Exit::Signal(libc::WTERMSIG(status))
        };
        out.push((pid, exit));
    }
    out
}

pub fn kill(pid: i32, sig: i32) {
    unsafe {
        libc::kill(pid, sig);
    }
}

pub fn power_off() -> ! {
    unsafe {
        libc::sync();
        libc::reboot(if cfg!(target_arch = "x86_64") { libc::RB_AUTOBOOT } else { libc::RB_POWER_OFF });
        // x86_64: no ACPI, so power-off halts; reboot=k's reset ends the VM.
        // reboot(2) returns only on failure; exiting PID 1 then panics the
        // kernel, and panic=-1 reboots, which ends the VM anyway.
        libc::_exit(1);
    }
}

/// Ctrl-Alt-Del becomes SIGINT to PID 1 instead of an immediate reboot.
pub fn disable_cad() {
    unsafe {
        libc::reboot(libc::RB_DISABLE_CAD);
    }
}

pub fn uptime_ms() -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe {
        libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut ts);
    }
    ts.tv_sec as u64 * 1000 + ts.tv_nsec as u64 / 1_000_000
}

/// A listening AF_VSOCK stream socket on `port`, any CID. Guest root can open
/// vsock; apps cannot (agent-init's seccomp filter refuses AF_VSOCK).
pub fn vsock_listen(port: u32) -> io::Result<OwnedFd> {
    unsafe {
        let fd = libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0);
        if fd < 0 {
            return Err(errno());
        }
        let fd = OwnedFd::from_raw_fd(fd);
        use std::os::fd::AsRawFd;
        let mut addr: libc::sockaddr_vm = std::mem::zeroed();
        addr.svm_family = libc::AF_VSOCK as _;
        addr.svm_port = port;
        addr.svm_cid = libc::VMADDR_CID_ANY;
        if libc::bind(fd.as_raw_fd(), (&addr as *const libc::sockaddr_vm).cast(), std::mem::size_of::<libc::sockaddr_vm>() as _) < 0 {
            return Err(errno());
        }
        if libc::listen(fd.as_raw_fd(), 16) < 0 {
            return Err(errno());
        }
        Ok(fd)
    }
}

/// A connected AF_VSOCK stream socket to `cid`:`port`. With libkrun, CID 2
/// (the host) on a port mapped without `listen` reaches the host Unix socket
/// berth-vmm listens on.
pub fn vsock_connect(cid: u32, port: u32) -> io::Result<OwnedFd> {
    unsafe {
        let fd = libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0);
        if fd < 0 {
            return Err(errno());
        }
        let fd = OwnedFd::from_raw_fd(fd);
        use std::os::fd::AsRawFd;
        let mut addr: libc::sockaddr_vm = std::mem::zeroed();
        addr.svm_family = libc::AF_VSOCK as _;
        addr.svm_port = port;
        addr.svm_cid = cid;
        loop {
            if libc::connect(fd.as_raw_fd(), (&addr as *const libc::sockaddr_vm).cast(), std::mem::size_of::<libc::sockaddr_vm>() as _) == 0 {
                return Ok(fd);
            }
            let e = errno();
            if e.kind() != io::ErrorKind::Interrupted {
                return Err(e);
            }
        }
    }
}

pub fn accept(listener: RawFd) -> io::Result<OwnedFd> {
    loop {
        let fd = unsafe { libc::accept4(listener, std::ptr::null_mut(), std::ptr::null_mut(), libc::SOCK_CLOEXEC) };
        if fd >= 0 {
            return Ok(unsafe { OwnedFd::from_raw_fd(fd) });
        }
        let e = errno();
        if e.kind() != io::ErrorKind::Interrupted {
            return Err(e);
        }
    }
}

/// SO_SNDTIMEO, so one stalled host reader cannot block a writer forever.
pub fn set_send_timeout(fd: RawFd, t: Duration) {
    let tv = libc::timeval { tv_sec: t.as_secs() as _, tv_usec: t.subsec_micros() as _ };
    unsafe {
        libc::setsockopt(fd, libc::SOL_SOCKET, libc::SO_SNDTIMEO, (&tv as *const libc::timeval).cast(), std::mem::size_of::<libc::timeval>() as _);
    }
}

/// SO_RCVTIMEO.
pub fn set_recv_timeout(fd: RawFd, t: Duration) {
    let tv = libc::timeval { tv_sec: t.as_secs() as _, tv_usec: t.subsec_micros() as _ };
    unsafe {
        libc::setsockopt(fd, libc::SOL_SOCKET, libc::SO_RCVTIMEO, (&tv as *const libc::timeval).cast(), std::mem::size_of::<libc::timeval>() as _);
    }
}

pub fn shutdown_write(fd: RawFd) {
    unsafe {
        libc::shutdown(fd, libc::SHUT_WR);
    }
}

pub fn chown(path: &str, uid: u32, gid: u32) -> io::Result<()> {
    std::os::unix::fs::chown(path, Some(uid), Some(gid))
}

pub fn chmod(path: &str, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

/// install -d -m MODE -o UID -g GID: mkdir -p, then set owner and mode on the
/// leaf (chmod after chown, so a setgid bit survives).
pub fn install_dir(path: &str, mode: u32, uid: u32, gid: u32) -> io::Result<()> {
    std::fs::create_dir_all(path)?;
    chown(path, uid, gid)?;
    chmod(path, mode)
}
