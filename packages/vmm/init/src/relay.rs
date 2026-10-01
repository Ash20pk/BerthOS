//! The RPC relay: one vsock listener per app (RPC_PORT_BASE + index), kept
//! for the life of the VM, onto an app process that is also kept for the life
//! of the VM. It replaces the spike's `socat VSOCK-LISTEN:5000,fork EXEC:...`,
//! which started a new app per connection.
//!
//! The framing is the SDK's own, unchanged: one JSON object per line,
//! `{"id","export","input"}` in, `{"id","result"}` or `{"id","error"}` out
//! (packages/sdk/src/rpc.ts, docker-orchestrator's stdio-rpc.ts).
//!
//! Socket mode (default): each host connection gets its own connection to
//! the app's /run/berth/<app>/rpc.sock, which the SDK's runtime serves
//! concurrently. The app's stdout and stderr are logs only, so nothing an app
//! prints can land in an RPC stream.
//!
//! Stdio mode: the app's stdin/stdout carry RPC, as for a single-app Docker
//! container. Host connections are multiplexed onto that one stream by
//! rewriting each request's id to a relay-unique one and mapping the answer
//! back. A stdout line that is not an answer to a pending request is a log
//! line, and goes to the log stream instead.

use crate::hub;
use crate::sys;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::process::{ChildStdin, ChildStdout};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Longest RPC line the stdio multiplexer will parse. Socket mode copies
/// bytes and leaves limits to the SDK.
pub const MAX_RPC_LINE: usize = 32 << 20;
/// How long a host connection waits for an app that is still booting.
const CONNECT_WAIT: Duration = Duration::from_secs(60);

/// Shared with the supervisor: set when the app has exited, so waiting
/// connections give up instead of waiting out CONNECT_WAIT.
pub type Gone = Arc<AtomicBool>;

pub fn serve_socket(app: String, port: u32, listener: OwnedFd, socket: String, gone: Gone) {
    std::thread::Builder::new()
        .name(format!("rpc-{app}"))
        .spawn(move || loop {
            let Ok(conn) = sys::accept(listener.as_raw_fd()) else { continue };
            let (app, socket, gone) = (app.clone(), socket.clone(), gone.clone());
            std::thread::spawn(move || {
                let host = File::from(conn);
                match connect_app(&socket, &gone) {
                    Some(sock) => splice(host, sock),
                    None => {
                        hub::info(&format!("rpc vsock:{port}: {app} is not serving {socket}; closing the host connection"));
                    }
                }
            });
        })
        .expect("spawn rpc thread");
}

fn connect_app(path: &str, gone: &Gone) -> Option<UnixStream> {
    let deadline = Instant::now() + CONNECT_WAIT;
    loop {
        if let Ok(s) = UnixStream::connect(path) {
            return Some(s);
        }
        if gone.load(Ordering::SeqCst) || Instant::now() > deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Copies both ways until either side closes, then half-closes the other.
fn splice(host: File, app: UnixStream) {
    let (Ok(mut host_r), Ok(mut app_w)) = (host.try_clone(), app.try_clone()) else { return };
    let up = std::thread::spawn(move || {
        let _ = std::io::copy(&mut host_r, &mut app_w);
        let _ = app_w.shutdown(std::net::Shutdown::Write);
    });
    let (mut app_r, mut host_w) = (app, host);
    let _ = std::io::copy(&mut app_r, &mut host_w);
    sys::shutdown_write(host_w.as_raw_fd());
    let _ = up.join();
}

struct Pending {
    conn: u64,
    id: Value,
}

pub struct StdioMux {
    app: String,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, Pending>>,
    conns: Mutex<HashMap<u64, File>>,
    next_conn: AtomicU64,
    next_req: AtomicU64,
}

impl StdioMux {
    pub fn new(app: String, stdin: ChildStdin) -> Arc<Self> {
        Arc::new(StdioMux {
            app,
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            conns: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(1),
            next_req: AtomicU64::new(1),
        })
    }

    /// The app's stdout: answers go back to the connection that asked;
    /// everything else is a log line.
    pub fn read_stdout(self: &Arc<Self>, stdout: ChildStdout) {
        let me = self.clone();
        std::thread::spawn(move || {
            let mut rd = BufReader::new(stdout);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match (&mut rd).take(MAX_RPC_LINE as u64).read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim_end_matches(['\n', '\r']);
                if !me.route_answer(line) && !line.trim().is_empty() {
                    hub::log(&me.app, "stdout", line);
                }
            }
        });
    }

    fn route_answer(&self, line: &str) -> bool {
        let Ok(mut v) = serde_json::from_str::<Value>(line) else { return false };
        let Some(key) = v.get("id").and_then(Value::as_str).map(String::from) else { return false };
        let Some(p) = self.pending.lock().unwrap().remove(&key) else { return false };
        v["id"] = p.id;
        if let Some(w) = self.conns.lock().unwrap().get_mut(&p.conn) {
            let _ = w.write_all(format!("{v}\n").as_bytes());
        }
        true
    }

    pub fn serve(self: &Arc<Self>, port: u32, listener: OwnedFd) {
        let me = self.clone();
        std::thread::Builder::new()
            .name(format!("rpc-{}", self.app))
            .spawn(move || loop {
                let Ok(conn) = sys::accept(listener.as_raw_fd()) else { continue };
                let id = me.next_conn.fetch_add(1, Ordering::SeqCst);
                let Ok(w) = conn.try_clone() else { continue };
                me.conns.lock().unwrap().insert(id, File::from(w));
                let me2 = me.clone();
                std::thread::spawn(move || {
                    me2.host_conn(id, File::from(conn));
                    me2.conns.lock().unwrap().remove(&id);
                    me2.pending.lock().unwrap().retain(|_, p| p.conn != id);
                });
                let _ = port;
            })
            .expect("spawn rpc thread");
    }

    fn host_conn(&self, conn: u64, r: File) {
        let mut rd = BufReader::new(r);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            let n = match (&mut rd).take(MAX_RPC_LINE as u64 + 1).read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            if n > MAX_RPC_LINE {
                self.answer(conn, json!({ "id": Value::Null, "error": "request line too long" }));
                return;
            }
            let line = String::from_utf8_lossy(&buf);
            if line.trim().is_empty() {
                continue;
            }
            let mut req = match serde_json::from_str::<Value>(&line) {
                Ok(v @ Value::Object(_)) => v,
                _ => {
                    self.answer(conn, json!({ "id": Value::Null, "error": "request is not a JSON object" }));
                    continue;
                }
            };
            let orig = req.get("id").cloned().unwrap_or(Value::Null);
            let key = format!("r{}", self.next_req.fetch_add(1, Ordering::SeqCst));
            self.pending.lock().unwrap().insert(key.clone(), Pending { conn, id: orig.clone() });
            req["id"] = Value::String(key.clone());
            let ok = self.stdin.lock().unwrap().write_all(format!("{req}\n").as_bytes()).is_ok();
            if !ok {
                self.pending.lock().unwrap().remove(&key);
                self.answer(conn, json!({ "id": orig, "error": format!("{} is not accepting requests (its stdin is closed)", self.app) }));
                return;
            }
        }
    }

    fn answer(&self, conn: u64, v: Value) {
        if let Some(w) = self.conns.lock().unwrap().get_mut(&conn) {
            let _ = w.write_all(format!("{v}\n").as_bytes());
        }
    }
}

/// Forwards a child's output stream into the log stream, one line at a time.
/// `on_line` sees each line first (the supervisor watches for the runtime's
/// "ready" line).
pub fn pipe_logs(src: String, stream: &'static str, r: impl Read + Send + 'static, on_line: impl Fn(&str) + Send + 'static) {
    std::thread::spawn(move || {
        let mut rd = BufReader::new(r);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match (&mut rd).take(1 << 20).read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let line = String::from_utf8_lossy(&buf);
            let line = line.trim_end_matches(['\n', '\r']);
            on_line(line);
            hub::log(&src, stream, line);
        }
    });
}
