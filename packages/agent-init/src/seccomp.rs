// The second half of "deny-by-default network access."
//
// Landlock's network rights (ABI v4) cover exactly two operations —
// AccessNet::ConnectTcp and AccessNet::BindTcp. There is no UDP right, no
// ICMP right, and no raw-socket right in any Landlock ABI, present or
// announced. So an app that declares no `network:connect:` capability gets a
// ruleset that stops every outbound TCP connect and still has completely
// unrestricted UDP: DNS-tunnelled exfiltration, QUIC (which is HTTP/3 over
// UDP, i.e. most of the modern web), and arbitrary C2. With CAP_NET_RAW —
// which is in Docker's *default* capability set, so it is present unless
// something removes it — it can also build TCP in userspace over AF_PACKET
// and never call connect(2) at all, which is the one syscall Landlock
// watches.
//
// Nothing in Landlock can close that. Backing the claim needs a second
// mechanism, and seccomp-bpf is the one that composes with everything else
// agent-init already does: a filter installed here is inherited across
// execve() and can never be lifted by the process it constrains, exactly
// like the Landlock domain it sits beside. The filter refuses socket(2) for
// the datagram and raw families rather than trying to police send/recv, so
// there is no fd to smuggle and no per-call check to race — an app with no
// declared network capability cannot obtain a UDP or raw socket in the first
// place.
//
// Deliberately narrow, in three ways worth stating plainly:
//
//   1. It is only installed for apps that declared NO network capability at
//      all. An app declaring `network:connect:443` keeps working UDP, because
//      it needs DNS to make that TCP connection useful and Landlock's
//      per-port model has no way to express "UDP 53 only." Closing that gap
//      means routing those apps' DNS through the egress broker (see
//      REMEDIATION.md 1.8) and is out of scope here.
//   2. AF_UNIX is untouched. Local RPC (packages/sdk's socket transport, the
//      context-bus and semantic-fs daemons) is all AF_UNIX, and it is not an
//      egress path. Restricting *which* Unix sockets an app may reach is
//      Landlock's job, and is tracked as REMEDIATION.md 1.4.
//   3. AF_NETLINK is untouched — it is how a process reads its own interface
//      list, and it is not routable off-box.
//
// x86_64 and aarch64 (the only two architectures this image is built for)
// both dispatch socket(2) as a real syscall. The multiplexed socketcall(2)
// entry point that would need separate filtering exists only on i386.
use std::collections::BTreeMap;

use seccompiler::{
    BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
    SeccompRule,
};

// From <bits/socket.h>. Spelled out rather than pulled from libc's constants
// because the values that matter here are the ones the *kernel* sees in the
// syscall arguments, and a seccomp filter is written against that ABI
// directly.
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

/// Returned to the app instead of a socket fd. EPERM rather than
/// EAFNOSUPPORT so the failure reads as "you were not allowed to do that"
/// in a log or a stack trace, rather than as a missing kernel feature that
/// someone might then try to "fix" by rebuilding the image.
const DENIED_ERRNO: u32 = libc::EPERM as u32;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_compiles_to_a_non_empty_bpf_program() {
        let program = compile_no_udp_no_raw_filter().expect("filter should compile");
        assert!(!program.is_empty(), "an empty program would be silently refused by apply_filter()");
    }

    /// The behavioural test, and the only one that proves anything: install
    /// the filter on a scratch thread (seccomp filters are per-thread until
    /// TSYNC is asked for, so this doesn't constrain the rest of the test
    /// binary) and make the actual socket(2) calls an app would make.
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
