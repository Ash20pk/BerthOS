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

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let socket_path =
        std::env::var("BERTH_CONTEXT_BUS_SOCKET").unwrap_or_else(|_| "/tmp/berth-context-bus.sock".to_string());

    // A stale socket file from a previous `berth dev` restart blocks binding.
    let _ = std::fs::remove_file(&socket_path);

    let listener = UnixListener::bind(&socket_path)?;
    eprintln!("[context-bus] listening on {socket_path}");

    let subscribers: Subscribers = Arc::new(Mutex::new(HashMap::new()));
    let next_conn_id = Arc::new(AtomicU64::new(1));

    loop {
        let (stream, _addr) = listener.accept().await?;
        let subscribers = subscribers.clone();
        let conn_id = next_conn_id.fetch_add(1, Ordering::SeqCst);

        tokio::spawn(async move {
            if let Err(err) = handle_connection(stream, conn_id, subscribers.clone()).await {
                eprintln!("[context-bus] connection {conn_id} error: {err}");
            }
            let mut subs = subscribers.lock().await;
            for topic_subs in subs.values_mut() {
                topic_subs.remove(&conn_id);
            }
            subs.retain(|_, v| !v.is_empty());
        });
    }
}

async fn handle_connection(stream: UnixStream, conn_id: u64, subscribers: Subscribers) -> std::io::Result<()> {
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

    let mut app_name = String::from("unknown");

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
                app_name = req.app;
                eprintln!("[context-bus] conn {conn_id} registered as \"{app_name}\"");
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
