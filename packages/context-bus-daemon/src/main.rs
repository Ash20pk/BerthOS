// Context Bus daemon — Phase 2's first real Agent OS primitive.
//
// One instance runs per agent sandbox (container), started by
// entrypoint.sh before any resident app's runtime. Every resident app
// process in that sandbox connects to the same Unix socket and
// publishes/subscribes to a shared semantic topic space — this is what lets
// apps react to each other without explicit orchestration (PRD Outcome 3).
//
// Wire format: length-prefixed (4-byte big-endian) protobuf Envelope frames,
// defined once in proto/context_bus.proto and shared with @berth/sdk's
// TypeScript client rather than re-specified on each side.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use prost::Message;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, Mutex};

mod peer;
use peer::{identify_from_system, PeerIdentity};

pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/berth.contextbus.rs"));
}

use pb::envelope::Kind;
use pb::{Ack, Envelope, Event};

type Payload = Vec<u8>;
/// topic -> (connection id -> outgoing queue for that connection)
type Subscribers = Arc<Mutex<HashMap<String, HashMap<u64, mpsc::Sender<Payload>>>>>;

/// Per-connection outgoing queue depth. Deliberately bounded, not unbounded:
/// an unbounded queue meant a single slow or hung subscriber (its own writer
/// task stalled on a full socket buffer, or the process itself wedged) could
/// grow this daemon's memory without limit on every publish to a topic it
/// subscribed to — real, unbounded memory growth from one misbehaving app in
/// the same sandbox, not a hypothetical. Delivery is therefore at-most-once:
/// once a subscriber's queue is full, further events to it are dropped (see
/// try_send_payload below) rather than blocking the publisher or every other
/// subscriber waiting on the same global `subscribers` lock. 256 is a
/// generous burst allowance for this daemon's actual traffic (small,
/// infrequent JSON-ish event payloads between resident apps in one sandbox,
/// not a high-throughput message bus) — comfortably absorbing a burst
/// without hiding a truly stuck subscriber for long.
const SUBSCRIBER_QUEUE_CAPACITY: usize = 256;

/// Largest frame this daemon will allocate for. Events on this bus are small
/// JSON-ish payloads between resident apps in one sandbox, so 8 MiB is orders
/// of magnitude above real traffic and still refuses the 4 GiB a `0xFFFFFFFF`
/// length header used to reserve. Mirrored in semantic-fs-daemon's
/// control.go, which had the identical bug.
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Non-blocking by design: a full or closed queue means this one payload is
/// dropped for this one subscriber, logged, and everything else (this
/// publish to other subscribers, every other topic, every other connection)
/// proceeds unaffected. The alternative — `.send().await` while holding the
/// `subscribers` lock — would let one wedged subscriber stall the entire
/// daemon's publish path for every app in the sandbox, which is strictly
/// worse than the at-most-once drop this trades for.
fn try_send_payload(sender: &mpsc::Sender<Payload>, payload: Payload, context: &str) {
    if let Err(err) = sender.try_send(payload) {
        eprintln!("[context-bus] dropped a message ({context}): {err}");
    }
}

/// Hands a just-bound control socket to the shared `berth` group, mode 0660.
///
/// connect(2) on a pathname socket needs write permission on it, and a socket
/// created under the default umask is 0755 — reachable by root and nobody
/// else. Every app in the sandbox is meant to reach this daemon (that is what
/// the bus *is*), so the moment apps stop being uid 0 this is what keeps it
/// true. See docs/per-app-uid-design.md's socket table.
///
/// Deliberately not fatal. A missing group or a filesystem that refuses the
/// chown leaves the daemon reachable by root, which is strictly better than
/// refusing to start — and today, before any app has a uid of its own, it
/// changes nothing at all.
fn grant_shared_group(socket_path: &str) {
    use std::os::unix::fs::PermissionsExt;

    let gid: u32 = match std::env::var("BERTH_SHARED_GID") {
        Ok(raw) => match raw.parse() {
            Ok(gid) => gid,
            Err(_) => {
                eprintln!("[context-bus] WARNING: BERTH_SHARED_GID={raw:?} is not a number — leaving {socket_path} root-owned");
                return;
            }
        },
        Err(_) => 9999,
    };
    if gid == 0 {
        return;
    }
    if let Err(err) = std::os::unix::fs::chown(socket_path, None, Some(gid)) {
        eprintln!("[context-bus] WARNING: chown {socket_path} to gid {gid} failed ({err}) — a non-root app cannot reach it");
        return;
    }
    if let Err(err) = std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o660)) {
        eprintln!("[context-bus] WARNING: chmod {socket_path} failed ({err}) — a non-root app cannot reach it");
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let socket_path =
        std::env::var("BERTH_CONTEXT_BUS_SOCKET").unwrap_or_else(|_| "/tmp/berth-context-bus.sock".to_string());

    // A stale socket file from a previous `berth dev` restart blocks binding.
    let _ = std::fs::remove_file(&socket_path);

    let listener = UnixListener::bind(&socket_path)?;
    grant_shared_group(&socket_path);
    eprintln!("[context-bus] listening on {socket_path}");

    let subscribers: Subscribers = Arc::new(Mutex::new(HashMap::new()));
    let next_conn_id = Arc::new(AtomicU64::new(1));

    loop {
        let (stream, _addr) = listener.accept().await?;
        let subscribers = subscribers.clone();
        let conn_id = next_conn_id.fetch_add(1, Ordering::SeqCst);

        // SO_PEERCRED, read once at accept() rather than per frame: the uid
        // the kernel stamped on this connection cannot change for its
        // lifetime, and a client cannot influence it. This is what makes the
        // `app` field of a Register frame advisory rather than authoritative
        // (REMEDIATION.md 1.14). A failure to read it is treated as the most
        // restrictive answer available, not as root.
        let peer = match stream.peer_cred() {
            Ok(cred) => identify_from_system(cred.uid()),
            Err(err) => {
                eprintln!("[context-bus] conn {conn_id}: could not read peer credentials ({err}) — treating it as an unidentified caller");
                PeerIdentity::Unknown(u32::MAX)
            }
        };

        tokio::spawn(async move {
            if let Err(err) = handle_connection(stream, conn_id, subscribers, peer).await {
                eprintln!("[context-bus] connection {conn_id} error: {err}");
            }
        });
    }
}

async fn handle_connection(stream: UnixStream, conn_id: u64, subscribers: Subscribers, peer: PeerIdentity) -> std::io::Result<()> {
    let (mut read_half, write_half) = stream.into_split();
    let (tx, mut rx) = mpsc::channel::<Payload>(SUBSCRIBER_QUEUE_CAPACITY);

    // Writer task: drains this connection's outgoing queue (events pushed to
    // it because some other connection published to a topic it subscribed
    // to) and frames them onto the wire.
    let writer = tokio::spawn(async move {
        let mut write_half = write_half;
        while let Some(bytes) = rx.recv().await {
            if write_frame(&mut write_half, &bytes).await.is_err() {
                break;
            }
        }
    });

    // Attributed from the kernel's answer before any Register frame arrives,
    // so a connection that publishes without registering is still logged as
    // whoever it actually is rather than as "unknown".
    let mut app_name = peer.resolve_claim("");

    loop {
        let frame = match read_frame(&mut read_half).await {
            Ok(Some(frame)) => frame,
            Ok(None) => break, // clean EOF
            Err(err) => {
                eprintln!("[context-bus] conn {conn_id} read error: {err}");
                break;
            }
        };

        let envelope = match Envelope::decode(frame.as_slice()) {
            Ok(e) => e,
            Err(err) => {
                eprintln!("[context-bus] conn {conn_id} decode error: {err}");
                continue;
            }
        };

        match envelope.kind {
            Some(Kind::Register(req)) => {
                // The frame's `app` is a request, not a fact. Whether it is
                // honoured is the kernel's call, made above.
                if peer.contradicts(&req.app) {
                    eprintln!(
                        "[context-bus] conn {conn_id} claimed to be \"{}\" but the kernel says {peer:?} — registering it as the latter",
                        req.app
                    );
                }
                app_name = peer.resolve_claim(&req.app);
                eprintln!("[context-bus] conn {conn_id} registered as \"{app_name}\" ({peer:?})");
                send_ack(&tx, true, "");
            }
            Some(Kind::Subscribe(req)) => {
                let mut subs = subscribers.lock().await;
                subs.entry(req.topic.clone()).or_default().insert(conn_id, tx.clone());
                eprintln!("[context-bus] \"{app_name}\" subscribed to \"{}\"", req.topic);
                send_ack(&tx, true, "");
            }
            Some(Kind::Unsubscribe(req)) => {
                let mut subs = subscribers.lock().await;
                if let Some(topic_subs) = subs.get_mut(&req.topic) {
                    topic_subs.remove(&conn_id);
                }
                send_ack(&tx, true, "");
            }
            Some(Kind::Publish(req)) => {
                let subs = subscribers.lock().await;
                if let Some(topic_subs) = subs.get(&req.topic) {
                    let event = Envelope {
                        kind: Some(Kind::Event(Event {
                            topic: req.topic.clone(),
                            payload: req.payload.clone(),
                        })),
                    };
                    let mut buf = Vec::new();
                    event.encode(&mut buf).ok();
                    for (subscriber_id, sender) in topic_subs {
                        // Don't echo a publish back to its own publisher.
                        if *subscriber_id == conn_id {
                            continue;
                        }
                        try_send_payload(sender, buf.clone(), &format!("event on \"{}\" to conn {subscriber_id}", req.topic));
                    }
                }
                eprintln!("[context-bus] \"{app_name}\" published to \"{}\"", req.topic);
                send_ack(&tx, true, "");
            }
            Some(Kind::Event(_)) | Some(Kind::Ack(_)) | None => {
                eprintln!("[context-bus] conn {conn_id} sent an envelope the server doesn't accept as a request");
            }
        }
    }

    // Remove every Sender clone this connection stashed in `subscribers` (one
    // per topic it subscribed to) *before* dropping our own `tx` and waiting
    // on the writer task below — otherwise this is a circular wait: the
    // writer's `rx.recv()` only returns `None` once every clone of `tx` is
    // dropped, but the clones held in `subscribers` were only ever removed by
    // cleanup code that used to run in main()'s spawned task *after*
    // handle_connection() returned — which can't happen until `writer.await`
    // resolves. Nothing broke that cycle except a subsequent publish to one
    // of this connection's topics failing to write to the now-closed socket,
    // which is what let the writer's loop `break` from the outside. Doing
    // the removal here — before drop(tx)/writer.await — breaks the cycle
    // directly instead of waiting on an unrelated future event.
    {
        let mut subs = subscribers.lock().await;
        for topic_subs in subs.values_mut() {
            topic_subs.remove(&conn_id);
        }
        subs.retain(|_, v| !v.is_empty());
    }

    drop(tx);
    let _ = writer.await;
    Ok(())
}

fn send_ack(tx: &mpsc::Sender<Payload>, ok: bool, error: &str) {
    let ack = Envelope {
        kind: Some(Kind::Ack(Ack { ok, error: error.to_string() })),
    };
    let mut buf = Vec::new();
    if ack.encode(&mut buf).is_ok() {
        // Safe to drop under backpressure exactly like a forwarded event: the
        // TypeScript client (see @berth/sdk's context-bus/unix-socket.ts)
        // already treats register/publish/subscribe acks as fire-and-forget
        // and never blocks waiting for one, so there's no caller left hanging.
        try_send_payload(tx, buf, "ack");
    }
}

async fn read_frame(reader: &mut (impl AsyncRead + Unpin)) -> std::io::Result<Option<Vec<u8>>> {
    let mut len_bytes = [0u8; 4];
    match reader.read_exact(&mut len_bytes).await {
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err) => return Err(err),
    }
    let len = u32::from_be_bytes(len_bytes) as usize;
    // Checked before the allocation, which is the whole point: a 4-byte header
    // of 0xFFFFFFFF used to allocate 4 GiB in this daemon, which runs as root
    // outside any Landlock domain and is reachable by every app in the sandbox
    // (REMEDIATION.md 1.14). The error is returned rather than skipped so the
    // connection is dropped — a client that framed one message this badly has
    // no credible next frame on the same stream.
    if len > MAX_FRAME_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("frame length {len} exceeds the {MAX_FRAME_BYTES}-byte maximum"),
        ));
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

async fn write_frame(writer: &mut (impl AsyncWrite + Unpin), bytes: &[u8]) -> std::io::Result<()> {
    let len = (bytes.len() as u32).to_be_bytes();
    writer.write_all(&len).await?;
    writer.write_all(bytes).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use pb::SubscribeRequest;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    /// `std::env::temp_dir()` (e.g. macOS's `/var/folders/.../T/`) plus a
    /// descriptive name easily blows past AF_UNIX's ~100-byte `sun_path`
    /// limit — using `/tmp` directly (short on every platform this runs on)
    /// and just the low bits of a nanosecond timestamp keeps this well
    /// under it while still being unique per test run.
    fn unique_socket_path(label: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64;
        std::path::PathBuf::from(format!("/tmp/cb-{label}-{nanos}.sock"))
    }

    async fn write_envelope(stream: &mut UnixStream, kind: Kind) {
        let envelope = Envelope { kind: Some(kind) };
        let mut buf = Vec::new();
        envelope.encode(&mut buf).unwrap();
        write_frame(stream, &buf).await.unwrap();
    }

    /// Regression test for the fix: a connection that subscribes and then
    /// disconnects (no unsubscribe, and — crucially — no *subsequent*
    /// publish from anyone) used to leak its Sender clone in `subscribers`
    /// forever. Cleanup only ran in main()'s spawned task after
    /// handle_connection() returned, which couldn't happen until the writer
    /// task's `rx.recv()` saw every clone of `tx` dropped — a circular wait
    /// only ever broken from the outside, by some future publish attempt
    /// failing to write to the now-dead socket. This drives real
    /// connections through a real listener/handle_connection() and asserts
    /// the map is already empty, with no publish ever sent by anyone.
    #[tokio::test]
    async fn subscriber_cleanup_does_not_require_a_subsequent_publish() {
        let socket_path = unique_socket_path("cleanup");
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).unwrap();

        let subscribers: Subscribers = Arc::new(Mutex::new(HashMap::new()));
        let next_conn_id = Arc::new(AtomicU64::new(1));

        let accept_subscribers = subscribers.clone();
        let accept_task = tokio::spawn(async move {
            loop {
                let (stream, _addr) = match listener.accept().await {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let subscribers = accept_subscribers.clone();
                let conn_id = next_conn_id.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    // The test harness runs as whoever ran `cargo test`, so it
                    // asks for the same identity path a real accept() takes.
                    let peer = stream.peer_cred().map(|c| identify_from_system(c.uid())).unwrap_or(PeerIdentity::Unknown(u32::MAX));
                    let _ = handle_connection(stream, conn_id, subscribers, peer).await;
                });
            }
        });

        for _ in 0..20 {
            let mut client = UnixStream::connect(&socket_path).await.unwrap();
            write_envelope(&mut client, Kind::Subscribe(SubscribeRequest { topic: "some-topic".to_string() })).await;
            drop(client); // disconnect immediately — no unsubscribe, no publish from anyone, ever
        }

        // Give the spawned handler tasks a moment to observe EOF and run
        // their cleanup tail.
        tokio::time::sleep(Duration::from_millis(300)).await;

        let subs = subscribers.lock().await;
        let remaining: usize = subs.values().map(|m| m.len()).sum();
        assert_eq!(remaining, 0, "every disconnected subscriber should have been cleaned up without needing a subsequent publish");
        drop(subs);

        accept_task.abort();
        let _ = std::fs::remove_file(&socket_path);
    }
}
