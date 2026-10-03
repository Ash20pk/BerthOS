//! The guest half of egress (docs/design/microvm-egress.md).
//!
//! The egress broker (egress-broker.cjs, uid 9002, confined by agent-init) is
//! gate 1. It cannot open AF_VSOCK (agent-init's seccomp filter refuses it,
//! and node has no vsock anyway), so berth-init serves a Unix socket for it,
//! DIAL_SOCKET, and copies each connection to a new vsock connection to the
//! host's EGRESS_PORT, where berth-vmm's dialer (gate 2) reads the request,
//! checks it against the host's own allowlist and the address block list,
//! and dials. This relay does not parse the stream: the host does, and it
//! trusts nothing that arrives from the guest, this process included.
//!
//! The socket is root:berth-egress 0660 inside a root:berth-egress 0750
//! directory, so only the broker (and root) can reach it; apps are not in
//! that group.

use crate::plan;
use crate::sys;
use serde_json::{json, Value};
use std::fs::File;
use std::io::{Read, Write};
use std::collections::BTreeSet;
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Most relayed connections at once; the host has its own cap.
const MAX_RELAYS: usize = 128;

/// The relay's state, so shutdown can close it before the unmounts: a bound
/// socket holds its path, and so does every connection accepted on it (Linux
/// gives the accepted socket the listener's path), which keeps /run busy.
static LISTENER_FD: AtomicI32 = AtomicI32::new(-1);
static STOPPING: AtomicBool = AtomicBool::new(false);
static DONE: AtomicBool = AtomicBool::new(false);
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static CONNS: Mutex<BTreeSet<RawFd>> = Mutex::new(BTreeSet::new());

/// Closes the listener and every relayed connection, waiting at most half a
/// second for the threads to let go: this is the shutdown path.
pub fn stop_relay() {
    let fd = LISTENER_FD.swap(-1, Ordering::SeqCst);
    if fd < 0 {
        return;
    }
    STOPPING.store(true, Ordering::SeqCst);
    // Wake the accept(): a connection of our own, and shutdown for good measure.
    let _ = UnixStream::connect(plan::DIAL_SOCKET);
    unsafe { libc::shutdown(fd, libc::SHUT_RDWR) };
    for c in CONNS.lock().unwrap().iter() {
        unsafe { libc::shutdown(*c, libc::SHUT_RDWR) };
    }
    let t0 = Instant::now();
    while !(DONE.load(Ordering::SeqCst) && ACTIVE.load(Ordering::SeqCst) == 0) && t0.elapsed() < Duration::from_millis(500) {
        std::thread::sleep(Duration::from_millis(2));
    }
    let _ = std::fs::remove_file(plan::DIAL_SOCKET);
}

/// Binds DIAL_SOCKET with the ownership described above and relays every
/// connection to vsock (VMADDR_CID_HOST, EGRESS_PORT).
pub fn serve_relay() -> std::io::Result<()> {
    // The egress and GitHub API brokers both dial out through it; the first
    // to start serves it for both.
    if LISTENER_FD.load(Ordering::SeqCst) >= 0 {
        return Ok(());
    }
    sys::install_dir(plan::EGRESS_DIR, 0o750, 0, plan::EGRESS_UID)?;
    let _ = std::fs::remove_file(plan::DIAL_SOCKET);
    let listener = UnixListener::bind(plan::DIAL_SOCKET)?;
    sys::chown(plan::DIAL_SOCKET, 0, plan::EGRESS_UID)?;
    sys::chmod(plan::DIAL_SOCKET, 0o660)?;
    LISTENER_FD.store(listener.as_raw_fd(), Ordering::SeqCst);
    std::thread::Builder::new().name("egress-relay".into()).spawn(move || {
        for conn in listener.incoming() {
            if STOPPING.load(Ordering::SeqCst) {
                break;
            }
            let Ok(conn) = conn else { continue };
            if ACTIVE.fetch_add(1, Ordering::SeqCst) >= MAX_RELAYS {
                ACTIVE.fetch_sub(1, Ordering::SeqCst);
                let mut c = &conn;
                let _ = c.write_all(b"ERR busy too many egress connections in this guest\n");
                continue;
            }
            let fd = conn.as_raw_fd();
            CONNS.lock().unwrap().insert(fd);
            std::thread::spawn(move || {
                match sys::vsock_connect(libc::VMADDR_CID_HOST, plan::EGRESS_PORT) {
                    Ok(v) => splice(&conn, File::from(v)),
                    Err(e) => {
                        let mut c = &conn;
                        let _ = c.write_all(format!("ERR dialer the host's egress port is not reachable ({e})\n").as_bytes());
                    }
                }
                CONNS.lock().unwrap().remove(&fd);
                drop(conn);
                ACTIVE.fetch_sub(1, Ordering::SeqCst);
            });
        }
        drop(listener);
        DONE.store(true, Ordering::SeqCst);
    })?;
    Ok(())
}

fn splice(local: &UnixStream, host: File) {
    let (Ok(mut l_r), Ok(mut h_w)) = (local.try_clone(), host.try_clone()) else { return };
    let up = std::thread::spawn(move || {
        let _ = std::io::copy(&mut l_r, &mut h_w);
        sys::shutdown_write(h_w.as_raw_fd());
    });
    let (mut h_r, mut l_w) = (host, local);
    let _ = std::io::copy(&mut h_r, &mut l_w);
    let _ = l_w.shutdown(std::net::Shutdown::Write);
    let _ = up.join();
}

/// Test hook (BERTH_VM_TEST_HOOKS=1 only): what a compromised guest root can
/// do, done by PID 1. Opens vsock EGRESS_PORT directly, bypassing the broker,
/// sends `request` verbatim plus a newline, reads the host's one-line answer,
/// and, if that was OK and `send` is given, sends it and returns the first
/// bytes that come back. The host decides; this only reports.
pub fn raw_probe(req: &Value) -> Value {
    let request = req.get("request").and_then(Value::as_str).unwrap_or("");
    let send = req.get("send").and_then(Value::as_str);
    let v = match sys::vsock_connect(libc::VMADDR_CID_HOST, plan::EGRESS_PORT) {
        Ok(v) => v,
        Err(e) => return json!({ "request": request, "connectError": e.to_string() }),
    };
    sys::set_recv_timeout(v.as_raw_fd(), Duration::from_secs(20));
    let mut f = File::from(v);
    if f.write_all(format!("{request}\n").as_bytes()).is_err() {
        return json!({ "request": request, "error": "write failed" });
    }
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    while buf.len() < 2048 {
        match f.read(&mut byte) {
            Ok(1) if byte[0] == b'\n' => break,
            Ok(1) => buf.push(byte[0]),
            _ => break,
        }
    }
    let reply = String::from_utf8_lossy(&buf).to_string();
    let mut data = None;
    if let (Some(s), true) = (send, reply.starts_with("OK ")) {
        let _ = f.write_all(s.as_bytes());
        sys::set_recv_timeout(f.as_raw_fd(), Duration::from_secs(10));
        let mut d = vec![0u8; 4096];
        let mut n = 0;
        while n < d.len() {
            match f.read(&mut d[n..]) {
                Ok(0) | Err(_) => break,
                Ok(k) => n += k,
            }
        }
        data = Some(String::from_utf8_lossy(&d[..n]).to_string());
    }
    json!({ "request": request, "reply": reply, "data": data })
}
