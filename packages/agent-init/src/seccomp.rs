// Three sets of seccomp-bpf filters, installed by main() immediately before
// exec().
//
//   1. no_new_namespaces. Installed for every app,
//      unconditionally. Without it, the capability bounding-set drop in
//      main.rs's drop_all_capabilities() is reversible by the app itself.
//   2. no_udp_no_raw. Installed only for apps that
//      declared no network capability at all.
//   3. no_io_uring_no_vsock. Installed for every app. io_uring would
//      otherwise create the sockets 2 refuses without calling socket(2), and
//      AF_VSOCK reaches a microVM's host without touching AF_INET at all.
//
// All are allow-by-default: they remove specific syscalls that neither
// Landlock nor the capability model can express, rather than acting as a
// syscall allowlist. An allowlist here would be a second, divergent copy of
// "what a Node runtime needs to run," and would break on the next Node release
// rather than on the next security review.
//
// They are installed as several filters rather than one because a seccompiler
// `SeccompFilter` carries a single match action, and these need different
// errnos (DENIED_ERRNO vs CLONE3_ERRNO and IO_URING_ERRNO below). The kernel
// evaluates every installed filter and applies the most restrictive result.
// Only 2 and 3 both match socket(2), on different address families and with
// the same EPERM, so no call gets a different answer for being matched by
// both.
//
// x86_64 and aarch64 — the only two architectures this image is built for —
// both dispatch socket(2), clone(2), unshare(2), setns(2), and io_uring's
// three syscalls as real syscalls with the argument order assumed below. The multiplexed socketcall(2) entry
// point that would need separate filtering exists only on i386, and the
// register-swapped clone(2) argument order exists only on s390x and cris.
use std::collections::BTreeMap;

use seccompiler::{
    BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
    SeccompRule,
};

/// Returned to the app instead of a socket fd, a new namespace, or a joined
/// one. EPERM rather than EAFNOSUPPORT/EINVAL so the failure reads as "you
/// were not allowed to do that" in a log or a stack trace, rather than as a
/// missing kernel feature that someone might then try to "fix" by rebuilding
/// the image.
const DENIED_ERRNO: u32 = libc::EPERM as u32;

// ---------------------------------------------------------------------------
// 1. Namespace creation
// ---------------------------------------------------------------------------
//
// main.rs drops CAP_SYS_ADMIN, CAP_NET_ADMIN, and CAP_NET_RAW from the
// *bounding* set, described there as "a hard ceiling a process can never widen
// for itself." That holds right up until the process creates a user namespace.
// Creating one requires no privilege at all, and on success the kernel grants
// the creator a full capability set inside the new namespace — including a
// fresh CAP_FULL_SET bounding set. The audit that found this reproduced it in
// the real berth/filesystem image, after dropping exactly what agent-init
// drops:
//
//     $ unshare -Urm sh -c 'grep CapEff /proc/self/status; mount -t tmpfs none /mnt'
//     CapEff: 000001ffffffffff
//     MOUNT_SUCCEEDED_CAP_REGAINED
//
// Docker's own default seccomp profile blocks exactly this — but it drops that
// block when the container holds CAP_SYS_ADMIN, which every Berth container
// does, unconditionally, for semantic-fs's FUSE mount (see container.ts's
// CapAdd). The platform default that would normally cover this is disabled by
// a decision made three layers away for an unrelated reason.
//
// Landlock's filesystem rules survive the trick — they are inode-based, and
// restrict_self() binds the process rather than its namespace — so this is not
// a filesystem escape. What comes back is every CAP_SYS_ADMIN-gated syscall
// Landlock does not cover: mount(2), pivot_root(2), the rest of the namespace
// API, BPF.
//
// Fixing it here rather than by shipping a custom Docker seccomp profile is
// deliberate. A Docker profile would mean vendoring Docker's ~1000-line
// default and keeping it in sync forever to avoid silently losing everything
// else it blocks, and it would apply container-wide — including to the daemons
// entrypoint.sh starts before agent-init, one of which genuinely needs
// CAP_SYS_ADMIN to mount /context. A filter installed here is inherited across
// execve(), irrevocable, and scoped to exactly the process this binary exists
// to constrain: the same properties as the Landlock domain beside it.
//
// NOT closed by this: those pre-exec daemons still run with the container's
// full capability set outside any filter, and the container still holds
// CAP_SYS_ADMIN container-wide. Removing that grant — mounting /context from a
// separate init step and dropping the cap before any app process exists — is
// the real fix and remains open.

// From <linux/sched.h>. Spelled out rather than pulled from libc because the
// values that matter here are the ones the *kernel* sees in the syscall
// arguments, and a seccomp filter is written against that ABI directly.
const CLONE_NEWNS: u64 = 0x0002_0000;
const CLONE_NEWCGROUP: u64 = 0x0200_0000;
const CLONE_NEWUTS: u64 = 0x0400_0000;
const CLONE_NEWIPC: u64 = 0x0800_0000;
const CLONE_NEWUSER: u64 = 0x1000_0000;
const CLONE_NEWPID: u64 = 0x2000_0000;
const CLONE_NEWNET: u64 = 0x4000_0000;
const CLONE_NEWTIME: u64 = 0x0000_0080;

/// The flags refused in `clone(2)`'s first argument.
///
/// CLONE_NEWUSER is the one that matters — it is the only namespace type an
/// unprivileged process can create, and so the only one still reachable after
/// the bounding-set drop. The other six are refused for defence in depth: they
/// each require CAP_SYS_ADMIN, so today they would already fail with EPERM
/// from the capability check, and this filter is what keeps that true if the
/// drop is ever weakened or the container's CapAdd list grows.
///
/// CLONE_NEWTIME is deliberately absent from this list and present in
/// `UNSHARE_DENIED_FLAGS` below. Its value (0x80) falls inside clone(2)'s
/// CSIGNAL mask — the low byte of `clone_flags` is the child's exit signal —
/// and the kernel rejects CLONE_NEWTIME for clone(2) outright, accepting it
/// only via unshare(2) and clone3(2). Including it here would filter a bit
/// that clone(2) reads as part of an exit-signal number rather than as a
/// namespace flag.
const CLONE_DENIED_FLAGS: [u64; 7] = [
    CLONE_NEWUSER,
    CLONE_NEWNS,
    CLONE_NEWCGROUP,
    CLONE_NEWUTS,
    CLONE_NEWIPC,
    CLONE_NEWPID,
    CLONE_NEWNET,
];

/// The same set for `unshare(2)`, which has no CSIGNAL field and does accept
/// CLONE_NEWTIME.
const UNSHARE_DENIED_FLAGS: [u64; 8] = [
    CLONE_NEWUSER,
    CLONE_NEWNS,
    CLONE_NEWCGROUP,
    CLONE_NEWUTS,
    CLONE_NEWIPC,
    CLONE_NEWPID,
    CLONE_NEWNET,
    CLONE_NEWTIME,
];

/// clone3(2) takes its flags in a `struct clone_args` behind a pointer, and
/// seccomp-bpf cannot dereference pointers — there is no way to inspect the
/// flags, so a flag-matching rule is impossible and clone3 would otherwise be
/// an unfiltered path to every flag `CLONE_DENIED_FLAGS` refuses.
///
/// ENOSYS rather than EPERM because that is the answer a libc is written to
/// expect: glibc's `pthread_create` tries clone3 first and falls back to
/// clone(2) on ENOSYS, and Docker's own default profile has returned ENOSYS
/// here since 20.10.10 — so every container image in the world already runs
/// this way. EPERM would instead surface as a hard thread-creation failure.
/// This image is Alpine/musl, which does not call clone3 at all, so the
/// fallback path is belt-and-braces rather than load-bearing.
const CLONE3_ERRNO: u32 = libc::ENOSYS as u32;

/// Built separately from `install()` so the unit tests can assert the shape of
/// the filter — and, in the behavioural test, its actual runtime effect —
/// without this process having to permanently constrain itself.
///
/// Returns two programs: the EPERM one (clone/unshare/setns) and the ENOSYS one
/// (clone3). See the module header for why they can't be a single filter.
pub fn compile_no_new_namespaces_filters() -> Result<[BpfProgram; 2], Box<dyn std::error::Error>> {
    let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();

    // MaskedEq(flag) == flag matches "this bit is set," which is what a flags
    // argument needs — an equality compare against the whole argument would be
    // bypassed by OR-ing in any other flag, which every real caller does
    // anyway (`unshare -Urm` passes NEWUSER|NEWNS|NEWPID together).
    rules.insert(libc::SYS_clone, flag_rules(&CLONE_DENIED_FLAGS)?);
    rules.insert(libc::SYS_unshare, flag_rules(&UNSHARE_DENIED_FLAGS)?);

    // setns(2) is refused whole rather than per-nstype: `setns(fd, 0)` joins
    // whatever namespace the fd refers to without naming a type, so there is
    // no argument to match on. Nothing in a resident app's runtime calls it.
    // An empty rule vector is seccompiler's form for "match this syscall
    // unconditionally," as opposed to a vector of argument conditions.
    rules.insert(libc::SYS_setns, vec![]);

    let deny_eperm = SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(DENIED_ERRNO),
        std::env::consts::ARCH.try_into()?,
    )?;

    let mut clone3_rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
    clone3_rules.insert(libc::SYS_clone3, vec![]);
    let deny_clone3 = SeccompFilter::new(
        clone3_rules,
        SeccompAction::Allow,
        SeccompAction::Errno(CLONE3_ERRNO),
        std::env::consts::ARCH.try_into()?,
    )?;

    Ok([deny_eperm.try_into()?, deny_clone3.try_into()?])
}

/// One rule per flag, OR'd together by seccompiler (a syscall matches if any of
/// its rules match).
fn flag_rules(flags: &[u64]) -> Result<Vec<SeccompRule>, Box<dyn std::error::Error>> {
    flags
        .iter()
        .map(|&flag| {
            // Dword: the flags argument is an unsigned long, but every value
            // above fits in 32 bits and the kernel reads the namespace flags
            // from the low word.
            let condition = SeccompCondition::new(
                0,
                SeccompCmpArgLen::Dword,
                SeccompCmpOp::MaskedEq(flag),
                flag,
            )?;
            Ok(SeccompRule::new(vec![condition])?)
        })
        .collect()
}

/// Installs both namespace filters on the calling thread. Inherited across the
/// execve() that follows in main(), and irrevocable from that point on.
pub fn install_no_new_namespaces_filter() -> Result<(), Box<dyn std::error::Error>> {
    for program in compile_no_new_namespaces_filters()? {
        seccompiler::apply_filter(&program)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 2. UDP and raw sockets
// ---------------------------------------------------------------------------
//
// The second half of "deny-by-default network access."
//
// Landlock's network rights (ABI v4) cover exactly two operations —
// AccessNet::ConnectTcp and AccessNet::BindTcp. There is no UDP right, no ICMP
// right, and no raw-socket right in any Landlock ABI, present or announced. So
// an app that declares no `network:connect:` capability gets a ruleset that
// stops every outbound TCP connect and still has completely unrestricted UDP:
// DNS-tunnelled exfiltration, QUIC (which is HTTP/3 over UDP, i.e. most of the
// modern web), and arbitrary C2. With CAP_NET_RAW — which is in Docker's
// *default* capability set, so it is present unless something removes it — it
// can also build TCP in userspace over AF_PACKET and never call connect(2) at
// all, which is the one syscall Landlock watches.
//
// The filter refuses socket(2) for the datagram and raw families rather than
// trying to police send/recv, so there is no fd to smuggle and no per-call
// check to race — an app with no declared network capability cannot obtain a
// UDP or raw socket in the first place.
//
// Deliberately narrow, in three ways worth stating plainly:
//
//   1. It is only installed for apps that declared NO network capability at
//      all. An app declaring `network:connect:443` keeps working UDP, because
//      it needs DNS to make that TCP connection useful and Landlock's per-port
//      model has no way to express "UDP 53 only." Closing that gap means
//      routing those apps' DNS through the egress broker and is out of
//      scope here.
//   2. AF_UNIX is untouched. Local RPC (packages/sdk's socket transport, the
//      context-bus and semantic-fs daemons) is all AF_UNIX, and it is not an
//      egress path. Restricting *which* Unix sockets an app may reach is
//      not this filter's job — per-app uids and socket modes do it.
//   3. AF_NETLINK is untouched — it is how a process reads its own interface
//      list, and it is not routable off-box.

// From <bits/socket.h>, spelled out for the same reason the clone flags above
// are.
const AF_INET: u64 = 2;
const AF_INET6: u64 = 10;
const AF_PACKET: u64 = 17;

const SOCK_DGRAM: u64 = 2;
const SOCK_RAW: u64 = 3;
// socket(2)'s `type` argument carries SOCK_NONBLOCK (0o4000) and SOCK_CLOEXEC
// (0o2000000) OR'd into the low bits' actual type. Comparing the whole
// argument for equality would be trivially bypassed by passing
// SOCK_DGRAM|SOCK_CLOEXEC, which is what every modern runtime does anyway.
const SOCK_TYPE_MASK: u64 = 0xf;

/// Built separately from `install()` so the unit tests can assert the shape
/// of the filter — and, in `install_in_thread_for_test`, its actual runtime
/// behaviour — without this process having to permanently constrain itself.
pub fn compile_no_udp_no_raw_filter() -> Result<BpfProgram, Box<dyn std::error::Error>> {
    let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();

    let mut socket_rules = Vec::new();
    for domain in [AF_INET, AF_INET6] {
        for sock_type in [SOCK_DGRAM, SOCK_RAW] {
            socket_rules.push(SeccompRule::new(vec![
                SeccompCondition::new(0, SeccompCmpArgLen::Dword, SeccompCmpOp::Eq, domain)?,
                SeccompCondition::new(
                    1,
                    SeccompCmpArgLen::Dword,
                    SeccompCmpOp::MaskedEq(SOCK_TYPE_MASK),
                    sock_type,
                )?,
            ])?);
        }
    }
    // AF_PACKET has no legitimate use for a resident app and every type it
    // supports is a link-layer escape hatch, so it's refused whole rather
    // than per-type.
    socket_rules.push(SeccompRule::new(vec![SeccompCondition::new(
        0,
        SeccompCmpArgLen::Dword,
        SeccompCmpOp::Eq,
        AF_PACKET,
    )?])?);

    rules.insert(libc::SYS_socket, socket_rules);

    let filter = SeccompFilter::new(
        rules,
        // Allow-by-default: this filter's whole job is to remove the two
        // socket families Landlock can't see. Everything else the app does
        // is already governed by the Landlock domain and the capability
        // bounding set, and a syscall allowlist here would be a second,
        // divergent copy of "what a Node runtime needs to run."
        SeccompAction::Allow,
        SeccompAction::Errno(DENIED_ERRNO),
        std::env::consts::ARCH.try_into()?,
    )?;

    Ok(filter.try_into()?)
}

/// Installs the filter on the calling thread. Inherited across the execve()
/// that follows in main(), and irrevocable from that point on.
pub fn install_no_udp_no_raw_filter() -> Result<(), Box<dyn std::error::Error>> {
    let program = compile_no_udp_no_raw_filter()?;
    // apply_filter() sets PR_SET_NO_NEW_PRIVS itself before the seccomp(2)
    // call, which is what makes the filter survive exec of a setuid binary
    // rather than being refused outright.
    seccompiler::apply_filter(&program)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 3. Ways around socket(2): io_uring and AF_VSOCK
// ---------------------------------------------------------------------------
//
// Installed for every app, whatever it declared.
//
// io_uring. The filter in section 2 works by matching socket(2)'s arguments,
// and seccomp only ever sees syscalls. io_uring moves the operation into a
// submission ring the kernel executes on the caller's behalf, so the syscalls
// seccomp sees are io_uring_setup and io_uring_enter, never socket(2). Since
// Linux 5.19 IORING_OP_SOCKET creates a socket that way, and
// `io_uring_creates_the_udp_socket_the_socket_filter_alone_refuses` below gets
// a UDP socket through it with section 2's filter installed. The same goes for
// anything else a future filter here might match on: seccomp cannot inspect a
// ring. So the three io_uring syscalls are refused outright.
//
// Docker's default seccomp profile has refused io_uring since 25.0, but that
// is not something to rely on: Kubernetes runs pods Unconfined unless told
// otherwise, and a microVM runtime brings its own profile or none.
//
// ENOSYS rather than EPERM, for the same reason as clone3: it is the answer a
// runtime reads as "this kernel has no io_uring" and falls back from. libuv
// (Node's event loop) probes with io_uring_setup and uses epoll and its
// threadpool when that fails; Python, musl and glibc never call it. The file
// and socket I/O an app does still works, through the ordinary syscalls every
// other filter here already governs.
//
// AF_VSOCK. vsock connects a guest to its hypervisor, addressed by context id
// and port rather than by IP. It is not AF_INET, so Landlock's TCP rules never
// apply to it, and section 2 never matched it. Under Docker it goes nowhere,
// but in a microVM it reaches every port the host maps to the guest, from an
// app whatever its network capabilities say. Nothing in a resident app needs
// it. Refused for every socket type, for every app.
//
// Considered and left alone:
//   - socketpair(2) hands back two ends already connected to each other.
//     AF_INET, AF_INET6 and AF_VSOCK refuse it (EOPNOTSUPP), so neither end
//     can have a remote peer.
//   - AF_NETLINK stays open, as section 2 explains. Changing routes or
//     interfaces through it needs CAP_NET_ADMIN, which drop_all_capabilities()
//     removes and section 1 keeps removed. mesh-daemon, the one process that
//     does need netlink write access, is not started through agent-init.
//   - AF_PACKET and AF_XDP both need CAP_NET_RAW, which is likewise gone.
//     Section 2 still refuses AF_PACKET outright for no-network apps.

const AF_VSOCK: u64 = 40;

/// io_uring's three syscalls, refused whole: a ring's contents are behind
/// pointers seccomp cannot follow, so there is no argument to match on.
const IO_URING_SYSCALLS: [i64; 3] = [libc::SYS_io_uring_setup, libc::SYS_io_uring_enter, libc::SYS_io_uring_register];

/// Returned for the io_uring syscalls. See the section header.
const IO_URING_ERRNO: u32 = libc::ENOSYS as u32;

/// Returns two programs, for the same reason as section 1: the ENOSYS one
/// (io_uring) and the EPERM one (AF_VSOCK).
pub fn compile_no_io_uring_no_vsock_filters() -> Result<[BpfProgram; 2], Box<dyn std::error::Error>> {
    let mut io_uring_rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
    for syscall in IO_URING_SYSCALLS {
        io_uring_rules.insert(syscall, vec![]);
    }
    let deny_io_uring = SeccompFilter::new(
        io_uring_rules,
        SeccompAction::Allow,
        SeccompAction::Errno(IO_URING_ERRNO),
        std::env::consts::ARCH.try_into()?,
    )?;

    let mut vsock_rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
    vsock_rules.insert(
        libc::SYS_socket,
        vec![SeccompRule::new(vec![SeccompCondition::new(
            0,
            SeccompCmpArgLen::Dword,
            SeccompCmpOp::Eq,
            AF_VSOCK,
        )?])?],
    );
    let deny_vsock = SeccompFilter::new(
        vsock_rules,
        SeccompAction::Allow,
        SeccompAction::Errno(DENIED_ERRNO),
        std::env::consts::ARCH.try_into()?,
    )?;

    Ok([deny_io_uring.try_into()?, deny_vsock.try_into()?])
}

/// Installs both filters on the calling thread. Inherited across the execve()
/// that follows in main(), and irrevocable from that point on.
pub fn install_no_io_uring_no_vsock_filters() -> Result<(), Box<dyn std::error::Error>> {
    for program in compile_no_io_uring_no_vsock_filters()? {
        seccompiler::apply_filter(&program)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn both_filter_sets_compile_to_non_empty_bpf_programs() {
        for program in compile_no_new_namespaces_filters().expect("namespace filters should compile") {
            assert!(!program.is_empty(), "an empty program would be silently refused by apply_filter()");
        }
        let program = compile_no_udp_no_raw_filter().expect("filter should compile");
        assert!(!program.is_empty(), "an empty program would be silently refused by apply_filter()");
        for program in compile_no_io_uring_no_vsock_filters().expect("io_uring/vsock filters should compile") {
            assert!(!program.is_empty(), "an empty program would be silently refused by apply_filter()");
        }
    }

    /// CLONE_NEWTIME's value collides with clone(2)'s CSIGNAL mask, so it
    /// belongs to unshare(2) only. Getting this backwards would filter a bit
    /// that clone(2) reads as part of an exit-signal number — a correctness
    /// bug that the behavioural test below would not necessarily catch, since
    /// no caller in this image passes an exit signal with that bit set.
    #[test]
    fn clone_newtime_is_filtered_on_unshare_but_not_on_clone() {
        assert!(UNSHARE_DENIED_FLAGS.contains(&CLONE_NEWTIME));
        assert!(!CLONE_DENIED_FLAGS.contains(&CLONE_NEWTIME));
        // Everything else must be in both — a flag dropped from one list is a
        // hole in exactly one syscall, which is the hardest kind to notice.
        for flag in CLONE_DENIED_FLAGS {
            assert!(UNSHARE_DENIED_FLAGS.contains(&flag), "{flag:#x} is filtered on clone but not unshare");
        }
    }

    /// The behavioural test, and the one that proves
    /// something: install the filter on a scratch thread (seccomp filters are
    /// per-thread until TSYNC is asked for, so this doesn't constrain the rest
    /// of the test binary) and make the actual unshare(2) call the reported
    /// exploit makes.
    ///
    /// Runs anywhere seccomp-bpf exists, which unlike Landlock includes Docker
    /// Desktop's linuxkit VM.
    #[test]
    fn creating_a_user_namespace_is_refused_while_a_plain_fork_still_works() {
        let (unshare_rc, unshare_errno, fork_rc) = std::thread::spawn(|| {
            install_no_new_namespaces_filter().expect("seccomp filter should install");

            // The exploit itself: CLONE_NEWUSER needs no privilege, and on
            // success hands back a full capability set in the new namespace.
            // SAFETY: unshare(2) with a constant flag; on success it would
            // only alter this scratch thread's namespaces.
            let rc = unsafe { libc::unshare(libc::CLONE_NEWUSER) };
            let errno = if rc < 0 { std::io::Error::last_os_error().raw_os_error().unwrap_or(0) } else { 0 };

            // A namespace-flag-free clone must still work, or this filter has
            // broken every child process the app spawns. Using fork(2) rather
            // than clone(2) directly because that is what a runtime actually
            // reaches for, and on musl it lands on SYS_clone with flags=SIGCHLD.
            // SAFETY: the child does nothing but _exit(0) — no allocation, no
            // locks, nothing that async-signal-safety rules out.
            let child = unsafe { libc::fork() };
            if child == 0 {
                unsafe { libc::_exit(0) };
            }
            if child > 0 {
                let mut status = 0;
                unsafe { libc::waitpid(child, &mut status, 0) };
            }

            (rc, errno, child)
        })
        .join()
        .expect("probe thread should not panic");

        assert!(
            unshare_rc < 0 && unshare_errno == libc::EPERM,
            "unshare(CLONE_NEWUSER) should have been refused with EPERM, got rc={unshare_rc} errno={unshare_errno} \
             — the capability bounding-set drop is reversible again",
        );
        assert!(
            fork_rc >= 0,
            "fork(2) was refused (rc={fork_rc}) — the namespace filter is too broad and would break every child process an app spawns",
        );
    }

    // A minimal io_uring client, just enough to submit one IORING_OP_SOCKET
    // and read its completion — the smallest demonstration of the bypass the
    // io_uring filter exists for. Hand-rolled against the kernel ABI rather
    // than pulled in as a dependency, for a test's worth of use. Layouts are
    // from <linux/io_uring.h>, and identical on x86_64 and aarch64.
    #[repr(C)]
    #[derive(Default)]
    struct SqringOffsets {
        head: u32,
        tail: u32,
        ring_mask: u32,
        ring_entries: u32,
        flags: u32,
        dropped: u32,
        array: u32,
        resv1: u32,
        user_addr: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct CqringOffsets {
        head: u32,
        tail: u32,
        ring_mask: u32,
        ring_entries: u32,
        overflow: u32,
        cqes: u32,
        flags: u32,
        resv1: u32,
        user_addr: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoUringParams {
        sq_entries: u32,
        cq_entries: u32,
        flags: u32,
        sq_thread_cpu: u32,
        sq_thread_idle: u32,
        features: u32,
        wq_fd: u32,
        resv: [u32; 3],
        sq_off: SqringOffsets,
        cq_off: CqringOffsets,
    }

    const IORING_OFF_SQ_RING: libc::off_t = 0;
    const IORING_OFF_CQ_RING: libc::off_t = 0x0800_0000;
    const IORING_OFF_SQES: libc::off_t = 0x1000_0000;
    const IORING_OP_SOCKET: u8 = 45;
    const IORING_ENTER_GETEVENTS: u32 = 1;
    const SQE_SIZE: usize = 64;
    const CQE_SIZE: usize = 16;

    /// How far an io_uring socket attempt got.
    #[derive(Debug, PartialEq)]
    enum UringSocket {
        /// io_uring_setup(2) itself failed with this errno.
        SetupRefused(i32),
        /// The ring worked and the SOCKET op completed with this errno
        /// (EINVAL on a kernel older than 5.19, which has no such op).
        OpFailed(i32),
        /// The kernel handed back a socket fd without socket(2) ever being
        /// called. Already closed by the time this is returned; carries the
        /// socket's SO_TYPE, read back from the fd before closing it.
        Created { so_type: i32 },
    }

    /// Asks the kernel for a socket through io_uring instead of socket(2).
    fn socket_via_io_uring(domain: i32, sock_type: i32) -> UringSocket {
        let mut params = IoUringParams::default();
        // SAFETY: io_uring_setup(2) writes only into `params`, which lives for
        // the duration of the call.
        let ring = unsafe { libc::syscall(libc::SYS_io_uring_setup, 1u32, &mut params as *mut IoUringParams) };
        if ring < 0 {
            return UringSocket::SetupRefused(std::io::Error::last_os_error().raw_os_error().unwrap_or(0));
        }
        let ring = ring as i32;

        let sq_len = params.sq_off.array as usize + params.sq_entries as usize * 4;
        let cq_len = params.cq_off.cqes as usize + params.cq_entries as usize * CQE_SIZE;
        let sqes_len = params.sq_entries as usize * SQE_SIZE;
        let map = |len: usize, offset: libc::off_t| {
            // SAFETY: a fresh shared mapping of the ring fd at one of the
            // kernel-defined offsets; the result is checked against MAP_FAILED.
            let ptr = unsafe {
                libc::mmap(
                    std::ptr::null_mut(),
                    len,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_SHARED | libc::MAP_POPULATE,
                    ring,
                    offset,
                )
            };
            assert_ne!(ptr, libc::MAP_FAILED, "mmap of the io_uring ring at {offset:#x} failed");
            ptr as *mut u8
        };
        let sq = map(sq_len, IORING_OFF_SQ_RING);
        let cq = map(cq_len, IORING_OFF_CQ_RING);
        let sqes = map(sqes_len, IORING_OFF_SQES);

        // SAFETY: every offset below comes from the kernel's own io_uring_params
        // and stays within the mappings sized from those same values. The ring
        // indices the kernel also touches are accessed through atomics.
        let outcome = unsafe {
            // io_uring_prep_socket(): fd = domain, off = type, len = protocol.
            std::ptr::write_bytes(sqes, 0, SQE_SIZE);
            *sqes = IORING_OP_SOCKET;
            *(sqes.add(4) as *mut i32) = domain;
            *(sqes.add(8) as *mut u64) = sock_type as u64;

            let sq_mask = *(sq.add(params.sq_off.ring_mask as usize) as *const u32);
            let sq_tail = &*(sq.add(params.sq_off.tail as usize) as *const AtomicU32);
            let tail = sq_tail.load(Ordering::Acquire);
            *(sq.add(params.sq_off.array as usize) as *mut u32).add((tail & sq_mask) as usize) = 0;
            sq_tail.store(tail.wrapping_add(1), Ordering::Release);

            let entered = libc::syscall(
                libc::SYS_io_uring_enter,
                ring,
                1u32,
                1u32,
                IORING_ENTER_GETEVENTS,
                std::ptr::null::<libc::c_void>(),
                0usize,
            );
            assert!(entered >= 0, "io_uring_enter failed: {}", std::io::Error::last_os_error());

            let cq_mask = *(cq.add(params.cq_off.ring_mask as usize) as *const u32);
            let cq_head = &*(cq.add(params.cq_off.head as usize) as *const AtomicU32);
            let head = cq_head.load(Ordering::Acquire);
            let cqe = cq.add(params.cq_off.cqes as usize + (head & cq_mask) as usize * CQE_SIZE);
            let res = *(cqe.add(8) as *const i32);
            cq_head.store(head.wrapping_add(1), Ordering::Release);

            if res < 0 {
                UringSocket::OpFailed(-res)
            } else {
                let mut so_type: libc::c_int = 0;
                let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
                libc::getsockopt(
                    res,
                    libc::SOL_SOCKET,
                    libc::SO_TYPE,
                    &mut so_type as *mut libc::c_int as *mut libc::c_void,
                    &mut len,
                );
                libc::close(res);
                UringSocket::Created { so_type }
            }
        };

        // SAFETY: unmapping exactly the regions mapped above, then closing
        // the ring fd they belong to.
        unsafe {
            libc::munmap(sq as *mut libc::c_void, sq_len);
            libc::munmap(cq as *mut libc::c_void, cq_len);
            libc::munmap(sqes as *mut libc::c_void, sqes_len);
            libc::close(ring);
        }
        outcome
    }

    /// The positive control for the io_uring filter, and the demonstration of
    /// the hole it closes: with only the socket(2) filter installed, a UDP
    /// socket that socket(2) refuses comes straight back from io_uring's
    /// IORING_OP_SOCKET. If this ever stops producing a socket on a kernel
    /// that has the op, the refusal test below has stopped proving anything,
    /// because the probe itself has broken.
    ///
    /// Skipped, loudly, where io_uring is unavailable to begin with: Docker's
    /// default seccomp profile refuses it, and so does a host with
    /// kernel.io_uring_disabled set. Run the crate's tests under
    /// `--security-opt seccomp=unconfined` to see it.
    #[test]
    fn io_uring_creates_the_udp_socket_the_socket_filter_alone_refuses() {
        let (direct_errno, via_uring) = std::thread::spawn(|| {
            install_no_udp_no_raw_filter().expect("seccomp filter should install");
            // SAFETY: socket(2) with constant arguments; closed if it succeeds.
            let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM, 0) };
            let errno = if fd < 0 { std::io::Error::last_os_error().raw_os_error().unwrap_or(0) } else { 0 };
            if fd >= 0 {
                unsafe { libc::close(fd) };
            }
            (errno, socket_via_io_uring(libc::AF_INET, libc::SOCK_DGRAM))
        })
        .join()
        .expect("probe thread should not panic");

        assert_eq!(direct_errno, libc::EPERM, "socket(AF_INET, SOCK_DGRAM) should be refused by the UDP filter");
        match via_uring {
            UringSocket::SetupRefused(errno) => {
                eprintln!("SKIPPED: io_uring_setup is unavailable in this environment (errno {errno}), so the bypass cannot be shown here");
            }
            UringSocket::OpFailed(libc::EINVAL) => {
                eprintln!("SKIPPED: this kernel has no IORING_OP_SOCKET (added in Linux 5.19)");
            }
            other => assert_eq!(
                other,
                UringSocket::Created { so_type: libc::SOCK_DGRAM },
                "expected io_uring to hand back the UDP socket socket(2) refused",
            ),
        }
    }

    /// The fix for the bypass above, with every filter an app gets installed
    /// together: io_uring_setup(2) answers ENOSYS, so there is no ring to
    /// submit a SOCKET op to; an AF_VSOCK socket is refused with EPERM for
    /// each type vsock supports; and TCP and Unix sockets still work.
    ///
    /// Unlike the positive control, nothing here is skipped where io_uring is
    /// unavailable: an outer profile answering EPERM instead of ENOSYS is
    /// exactly what this assertion is there to tell apart from this filter.
    #[test]
    fn io_uring_and_vsock_are_refused_while_tcp_and_unix_still_work() {
        let (via_uring, raw_setup_errno, socket_errnos) = std::thread::spawn(|| {
            install_no_new_namespaces_filter().expect("namespace filters should install");
            install_no_udp_no_raw_filter().expect("UDP/raw filter should install");
            install_no_io_uring_no_vsock_filters().expect("io_uring/vsock filters should install");

            let via_uring = socket_via_io_uring(libc::AF_INET, libc::SOCK_DGRAM);

            // The other two syscalls, each refused in its own right: a ring fd
            // inherited from before the filter, or passed in over a Unix
            // socket, must not be usable either.
            // SAFETY: invalid fds and null pointers; with the filter in place
            // neither call reaches the kernel's io_uring code at all.
            let enter = unsafe { libc::syscall(libc::SYS_io_uring_enter, -1, 0u32, 0u32, 0u32, std::ptr::null::<libc::c_void>(), 0usize) };
            let enter_errno = if enter < 0 { std::io::Error::last_os_error().raw_os_error().unwrap_or(0) } else { 0 };
            let register = unsafe { libc::syscall(libc::SYS_io_uring_register, -1, 0u32, std::ptr::null::<libc::c_void>(), 0u32) };
            let register_errno = if register < 0 { std::io::Error::last_os_error().raw_os_error().unwrap_or(0) } else { 0 };

            // (domain, type, expected-to-be-denied)
            let cases: [(libc::c_int, libc::c_int, bool); 5] = [
                (libc::AF_VSOCK, libc::SOCK_STREAM, true),
                (libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, true),
                (libc::AF_VSOCK, libc::SOCK_SEQPACKET, true),
                (libc::AF_INET, libc::SOCK_STREAM, false),
                (libc::AF_UNIX, libc::SOCK_STREAM, false),
            ];
            let socket_errnos = cases
                .iter()
                .map(|&(domain, sock_type, expect_denied)| {
                    // SAFETY: socket(2) with constant arguments; closed below.
                    let fd = unsafe { libc::socket(domain, sock_type, 0) };
                    let errno = if fd < 0 { std::io::Error::last_os_error().raw_os_error().unwrap_or(0) } else { 0 };
                    if fd >= 0 {
                        unsafe { libc::close(fd) };
                    }
                    (domain, sock_type, expect_denied, fd, errno)
                })
                .collect::<Vec<_>>();

            (via_uring, (enter_errno, register_errno), socket_errnos)
        })
        .join()
        .expect("probe thread should not panic");

        assert_eq!(
            via_uring,
            UringSocket::SetupRefused(libc::ENOSYS),
            "io_uring_setup should answer ENOSYS, so no ring exists to create a socket through",
        );
        assert_eq!(raw_setup_errno, (libc::ENOSYS, libc::ENOSYS), "io_uring_enter and io_uring_register should answer ENOSYS");
        for (domain, sock_type, expect_denied, fd, errno) in socket_errnos {
            if expect_denied {
                assert!(
                    fd < 0 && errno == libc::EPERM,
                    "socket({domain}, {sock_type}) should have been refused with EPERM, got fd={fd} errno={errno}",
                );
            } else {
                assert!(
                    errno != libc::EPERM,
                    "socket({domain}, {sock_type}) must not be refused by these filters, got errno={errno}",
                );
            }
        }
    }

    /// The behavioural test: install the filter on a
    /// scratch thread and make the actual socket(2) calls an app would make.
    ///
    /// This runs anywhere seccomp-bpf exists, which unlike Landlock includes
    /// Docker Desktop's linuxkit VM — so unlike the filesystem and TCP
    /// denials, this one is not degraded to "informational" in local dev.
    #[test]
    fn udp_and_raw_sockets_are_refused_while_tcp_and_unix_still_work() {
        let outcome = std::thread::spawn(|| {
            install_no_udp_no_raw_filter().expect("seccomp filter should install");

            // (domain, type, expected-to-be-denied)
            let cases: [(libc::c_int, libc::c_int, bool); 6] = [
                (libc::AF_INET, libc::SOCK_DGRAM, true),
                (libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, true),
                (libc::AF_INET6, libc::SOCK_DGRAM, true),
                (libc::AF_PACKET, libc::SOCK_RAW, true),
                // Still permitted: TCP is Landlock's to police per-port, and
                // AF_UNIX is how every local RPC path in the container works.
                (libc::AF_INET, libc::SOCK_STREAM, false),
                (libc::AF_UNIX, libc::SOCK_DGRAM, false),
            ];

            cases
                .iter()
                .map(|&(domain, sock_type, expect_denied)| {
                    // SAFETY: socket(2) with constant arguments; the returned
                    // fd (when there is one) is closed immediately below.
                    let fd = unsafe { libc::socket(domain, sock_type, 0) };
                    // Only meaningful on failure — errno is not cleared by a
                    // successful call, so reading it unconditionally would
                    // carry the previous case's EPERM forward.
                    let errno = if fd < 0 {
                        std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
                    } else {
                        0
                    };
                    if fd >= 0 {
                        // SAFETY: fd was just returned by socket(2).
                        unsafe { libc::close(fd) };
                    }
                    (domain, sock_type, expect_denied, fd, errno)
                })
                .collect::<Vec<_>>()
        })
        .join()
        .expect("probe thread should not panic");

        for (domain, sock_type, expect_denied, fd, errno) in outcome {
            if expect_denied {
                assert!(
                    fd < 0 && errno == libc::EPERM,
                    "socket({domain}, {sock_type}) should have been refused with EPERM, got fd={fd} errno={errno}",
                );
            } else {
                // AF_PACKET aside, a permitted case can still fail for
                // environmental reasons (no IPv6 in the sandbox, say) — what
                // must never happen is this filter being the reason.
                assert!(
                    errno != libc::EPERM,
                    "socket({domain}, {sock_type}) must not be refused by this filter, got errno={errno}",
                );
            }
        }
    }
}
