use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, RwLock};

use crate::coordinator::PeerView;
use crate::wg::TunnelMode;

pub struct SharedState {
    pub mode: TunnelMode,
    pub mesh_ip: String,
    pub peers: Vec<PeerView>,
}

pub type Shared = Arc<RwLock<SharedState>>;

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
enum Request {
    Status,
    Connect { peer: String },
}

#[derive(Serialize)]
struct StatusResponse {
    mode: &'static str,
    interface: &'static str,
    #[serde(rename = "meshIp")]
    mesh_ip: String,
    peers: Vec<PeerResponseEntry>,
}

#[derive(Serialize)]
struct PeerResponseEntry {
    name: String,
    #[serde(rename = "meshIp")]
    mesh_ip: String,
}

#[derive(Serialize)]
struct OkResponse {
    ok: bool,
}

/// Newline-delimited JSON on a Unix socket, not protobuf like
/// context-bus-daemon's IPC — this is low-frequency control-plane chatter
/// (a human/SDK asking "what's my mesh status"), not a high-volume data bus,
/// so the extra codegen/build-dependency isn't justified.
pub async fn run(socket_path: String, state: Shared, nudge_tx: mpsc::UnboundedSender<()>) -> std::io::Result<()> {
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)?;
    eprintln!("[mesh-daemon] control socket listening on {socket_path}");

    loop {
        let (stream, _addr) = listener.accept().await?;
        let state = state.clone();
        let nudge_tx = nudge_tx.clone();
        tokio::spawn(async move {
            if let Err(err) = handle_connection(stream, state, nudge_tx).await {
                eprintln!("[mesh-daemon] control connection error: {err}");
            }
        });
    }
}

async fn handle_connection(stream: UnixStream, state: Shared, nudge_tx: mpsc::UnboundedSender<()>) -> std::io::Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut lines = BufReader::new(read_half).lines();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(Request::Status) => {
                let s = state.read().await;
                serde_json::to_string(&StatusResponse {
                    mode: s.mode.as_str(),
                    interface: crate::wg::INTERFACE,
                    mesh_ip: s.mesh_ip.clone(),
                    peers: s.peers.iter().map(|p| PeerResponseEntry { name: p.name.clone(), mesh_ip: p.mesh_ip.clone() }).collect(),
                })
                .unwrap_or_else(|_| "{}".to_string())
            }
            Ok(Request::Connect { peer }) => {
                // Latency-hiding nudge only, not a gate — full-mesh
                // reachability (within mutual-match authorization) already
                // applies continuously via the 5s reconcile loop regardless
                // of whether anything ever calls "connect".
                eprintln!("[mesh-daemon] connect nudge for \"{peer}\" — triggering an immediate reconcile poll");
                let _ = nudge_tx.send(());
                serde_json::to_string(&OkResponse { ok: true }).unwrap()
            }
            Err(err) => format!("{{\"ok\":false,\"error\":{:?}}}", err.to_string()),
        };
        write_half.write_all(response.as_bytes()).await?;
        write_half.write_all(b"\n").await?;
    }
    Ok(())
}
