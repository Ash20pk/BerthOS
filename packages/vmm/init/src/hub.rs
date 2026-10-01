//! The two host-facing streams that are not RPC: logs and control.
//!
//! Logs (vsock LOG_PORT): one JSON object per line,
//!   {"t":<uptime ms>,"src":"<app>|berth-init|context-bus","stream":"stdout|stderr|init","line":"..."}
//! A ring buffer holds the most recent lines so a host that connects after
//! boot still sees the boot. One reader at a time; a new connection replaces
//! the old one. Every line is also mirrored to the console (hvc0).
//!
//! Control (vsock CONTROL_PORT): berth-init's events, one JSON object per
//! line, replayed from the start of the boot to every new connection and then
//! streamed live; and requests from the host, one JSON object per line:
//!   {"op":"status"}    -> {"event":"status",...} with every app's state,
//!                         pid, cgroup and the limits read back from it
//!   {"op":"shutdown"}  -> {"event":"shutting_down",...}, then a clean
//!                         power-off

use crate::sys;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const LOG_RING_BYTES: usize = 1 << 20;
/// Longest control request line accepted from the host.
pub const MAX_CONTROL_LINE: usize = 64 * 1024;

struct LogState {
    ring: VecDeque<String>,
    bytes: usize,
    reader: Option<File>,
}

struct CtlState {
    events: Vec<String>,
    readers: Vec<File>,
}

pub struct Hub {
    boot_id: String,
    log: Mutex<LogState>,
    ctl: Mutex<CtlState>,
}

static HUB: OnceLock<Hub> = OnceLock::new();

pub fn init(boot_id: String) {
    let _ = HUB.set(Hub {
        boot_id,
        log: Mutex::new(LogState { ring: VecDeque::new(), bytes: 0, reader: None }),
        ctl: Mutex::new(CtlState { events: Vec::new(), readers: Vec::new() }),
    });
}

fn hub() -> &'static Hub {
    HUB.get().expect("hub::init not called")
}

pub fn boot_id() -> &'static str {
    &hub().boot_id
}

/// One log line from `src`. Lines are capped at 64 KiB.
pub fn log(src: &str, stream: &str, line: &str) {
    let mut end = line.len().min(65536);
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    let line = &line[..end];
    eprintln!("[{src}] {line}");
    let rec = json!({ "t": sys::uptime_ms(), "src": src, "stream": stream, "line": line }).to_string();
    let Some(h) = HUB.get() else { return };
    let mut st = h.log.lock().unwrap();
    st.bytes += rec.len() + 1;
    st.ring.push_back(rec.clone());
    while st.bytes > LOG_RING_BYTES {
        match st.ring.pop_front() {
            Some(old) => st.bytes -= old.len() + 1,
            None => break,
        }
    }
    if let Some(r) = st.reader.as_mut() {
        if r.write_all(format!("{rec}\n").as_bytes()).is_err() {
            st.reader = None;
        }
    }
}

/// berth-init's own human-readable log line.
pub fn info(msg: &str) {
    log("berth-init", "init", msg);
}

/// A structured event: printed on the console as one un-prefixed JSON line
/// (the shape entrypoint.sh's cgroup events and agent-init's audit events
/// have, so `berth attest` can pick it out of a boot log the same way), and
/// sent to every control reader.
pub fn event(name: &str, fields: Value) {
    let mut obj = json!({ "source": "berth-init", "event": name, "bootId": boot_id(), "uptimeMs": sys::uptime_ms() });
    if let (Some(o), Value::Object(f)) = (obj.as_object_mut(), fields) {
        o.extend(f);
    }
    let line = obj.to_string();
    eprintln!("{line}");
    let mut st = hub().ctl.lock().unwrap();
    st.events.push(line.clone());
    let framed = format!("{line}\n");
    st.readers.retain_mut(|r| r.write_all(framed.as_bytes()).is_ok());
}

fn reply_line(name: &str, fields: Value) -> String {
    let mut obj = json!({ "source": "berth-init", "event": name, "bootId": boot_id(), "uptimeMs": sys::uptime_ms() });
    if let (Some(o), Value::Object(f)) = (obj.as_object_mut(), fields) {
        o.extend(f);
    }
    format!("{obj}\n")
}

/// A reply to one control connection only (not recorded, not broadcast).
/// Written under the control lock so it never interleaves with a broadcast
/// event on the same connection.
fn reply(w: &mut File, name: &str, fields: Value) -> std::io::Result<()> {
    let line = reply_line(name, fields);
    let _st = hub().ctl.lock().unwrap();
    w.write_all(line.as_bytes())
}

pub fn serve_logs(listener: OwnedFd) {
    std::thread::Builder::new()
        .name("logs".into())
        .spawn(move || loop {
            let Ok(conn) = sys::accept(listener.as_raw_fd()) else { continue };
            sys::set_send_timeout(conn.as_raw_fd(), Duration::from_secs(2));
            let mut f = File::from(conn);
            // A first line on every connection, so the host can tell a guest
            // that is listening from libkrun accepting on its behalf.
            let hello = json!({ "t": sys::uptime_ms(), "src": "berth-init", "stream": "init", "line": format!("log stream attached (boot {})", boot_id()) });
            let mut st = hub().log.lock().unwrap();
            let mut backlog = format!("{hello}\n");
            for l in &st.ring {
                backlog.push_str(l);
                backlog.push('\n');
            }
            let ok = f.write_all(backlog.as_bytes()).is_ok();
            if ok {
                st.reader = Some(f);
            }
        })
        .expect("spawn log thread");
}

/// What the control port can ask of the supervisor.
pub trait Control: Send + Sync + 'static {
    fn status(&self) -> Value;
    fn request_shutdown(&self, reason: &str);
    /// Test-only ops (BERTH_VM_TEST_HOOKS=1); None means not available.
    fn test_op(&self, _op: &str, _req: &Value) -> Option<Value> {
        None
    }
}

pub fn serve_control(listener: OwnedFd, ctl: &'static dyn Control) {
    std::thread::Builder::new()
        .name("control".into())
        .spawn(move || loop {
            let Ok(conn) = sys::accept(listener.as_raw_fd()) else { continue };
            sys::set_send_timeout(conn.as_raw_fd(), Duration::from_secs(2));
            let Ok(dup) = conn.try_clone() else { continue };
            let mut w = File::from(dup);
            {
                let mut st = hub().ctl.lock().unwrap();
                let mut backlog = reply_line("hello", json!({ "protocol": 1 }));
                for l in &st.events {
                    backlog.push_str(l);
                    backlog.push('\n');
                }
                if w.write_all(backlog.as_bytes()).is_err() {
                    continue;
                }
                if let Ok(c) = w.try_clone() {
                    st.readers.push(c);
                }
            }
            std::thread::spawn(move || control_conn(File::from(conn), w, ctl));
        })
        .expect("spawn control thread");
}

fn control_conn(r: File, mut w: File, ctl: &'static dyn Control) {
    let mut rd = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        // Bounded read: a line longer than MAX_CONTROL_LINE ends the connection.
        let n = match (&mut rd).take(MAX_CONTROL_LINE as u64 + 1).read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        if n > MAX_CONTROL_LINE {
            let _ = reply(&mut w, "error", json!({ "error": "control line too long" }));
            return;
        }
        let text = String::from_utf8_lossy(&buf);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let req = serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
        let op = req.get("op").and_then(Value::as_str).map(String::from);
        let res = match op.as_deref() {
            Some("status") => reply(&mut w, "status", ctl.status()),
            Some("shutdown") => {
                ctl.request_shutdown("host request");
                Ok(())
            }
            Some(other) => match ctl.test_op(other, &req) {
                Some(v) => reply(&mut w, other, v),
                None => reply(&mut w, "error", json!({ "error": "unknown op; expected status or shutdown" })),
            },
            None => reply(&mut w, "error", json!({ "error": "unknown op; expected status or shutdown" })),
        };
        if res.is_err() {
            return;
        }
    }
}

use std::io::Read;
