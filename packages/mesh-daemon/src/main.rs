// mesh-daemon — the real, kernel-embedded networking layer's per-sandbox
// agent. Started by entrypoint.sh before agent-init, the same way
// context-bus-daemon/semantic-fs-daemon are (unrestricted, outside any
// Landlock ruleset — see packages/agent-init). Generates a WireGuard
// keypair, registers with mesh-coordinator, brings up a real wg0 interface
// (kernel netdevice, or boringtun-cli userspace fallback), and reconciles
// its peer list against whatever mesh-coordinator's mutual-match
// introduction decides this peer is authorized to see. See
// docs/mesh-reference.md for what's real vs. deferred.
mod config;
mod control;
mod coordinator;
mod wg;

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::{mpsc, RwLock};

use config::Config;
use control::SharedState;

#[tokio::main]
async fn main() {
    let cfg = Config::from_env();
    eprintln!("[mesh-daemon] starting for peer \"{}\"", cfg.peer_name);

    let keypair = match wg::load_or_generate_keypair(&cfg.key_path).await {
        Ok(k) => k,
        Err(err) => {
            eprintln!("[mesh-daemon] WARNING: could not load/generate WireGuard keypair ({err}) — mesh disabled for this boot");
            run_control_socket_only(&cfg, wg::TunnelMode::Userspace, String::new()).await;
            return;
        }
    };

    let mode = wg::probe_kernel_support().await;
    eprintln!("[mesh-daemon] tunnel mode: {}", mode.as_str());

    let endpoint_host = detect_endpoint_host().await.unwrap_or_else(|| "127.0.0.1".to_string());
    let existing_token = tokio::fs::read_to_string(&cfg.token_path).await.ok().map(|s| s.trim().to_string());

    let client = coordinator::Client::new(cfg.coordinator_url.clone());
    let register_result = client
        .register(
            &cfg.peer_name,
            &keypair.public_key,
            &endpoint_host,
            cfg.listen_port,
            &cfg.mesh_peer_patterns,
            existing_token.as_deref(),
        )
        .await;

    let resp = match register_result {
        Ok(resp) => resp,
        Err(err) => {
            eprintln!("[mesh-daemon] WARNING: could not register with mesh-coordinator at {} ({err}) — mesh disabled for this boot", cfg.coordinator_url);
            run_control_socket_only(&cfg, mode, String::new()).await;
            return;
        }
    };

    let token = match resp.owner_token {
        Some(fresh) => {
            if let Some(parent) = Path::new(&cfg.token_path).parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            if let Err(err) = tokio::fs::write(&cfg.token_path, format!("{fresh}\n")).await {
                eprintln!("[mesh-daemon] WARNING: could not persist owner token ({err}) — re-registration after a restart may fail");
            }
            fresh
        }
        None => existing_token.unwrap_or_default(),
    };

    if let Err(err) = wg::write_config(&keypair.private_key, &resp.mesh_ip, cfg.listen_port, &to_wg_peers(&resp.peers), true).await {
        eprintln!("[mesh-daemon] WARNING: could not write {} ({err}) — mesh disabled for this boot", wg::CONFIG_PATH);
        run_control_socket_only(&cfg, mode, resp.mesh_ip).await;
        return;
    }
    if let Err(err) = wg::up(mode).await {
        eprintln!("[mesh-daemon] WARNING: wg-quick up failed ({err}) — mesh disabled for this boot");
        run_control_socket_only(&cfg, mode, resp.mesh_ip).await;
        return;
    }
    eprintln!("[mesh-daemon] wg0 up: mesh IP {}, {} peer(s)", resp.mesh_ip, resp.peers.len());
    for peer in &resp.peers {
        eprintln!("[mesh-daemon] peer \"{}\" -> {}", peer.name, peer.mesh_ip);
    }

    let state: control::Shared = Arc::new(RwLock::new(SharedState { mode, mesh_ip: resp.mesh_ip.clone(), peers: resp.peers }));

    let (nudge_tx, nudge_rx) = mpsc::unbounded_channel::<()>();

    let control_state = state.clone();
    let control_socket = cfg.control_socket.clone();
    tokio::spawn(async move {
        if let Err(err) = control::run(control_socket, control_state, nudge_tx).await {
            eprintln!("[mesh-daemon] control socket error: {err}");
        }
    });

    let reconcile_state = state.clone();
    let peer_name = cfg.peer_name.clone();
    let reconcile_token = token.clone();
    let reconcile_client = coordinator::Client::new(cfg.coordinator_url.clone());
    let reconcile_private_key = keypair.private_key.clone();
    let reconcile_listen_port = cfg.listen_port;
    tokio::spawn(async move {
        reconcile_loop(
            reconcile_client,
            peer_name,
            reconcile_token,
            reconcile_private_key,
            reconcile_listen_port,
            reconcile_state,
            nudge_rx,
        )
        .await;
    });

    wait_for_shutdown().await;
    eprintln!("[mesh-daemon] shutting down");
    let _ = client.deregister(&cfg.peer_name, &token).await;
    let _ = wg::down(mode).await;
}

/// Kernel/register failed — the mesh itself is inert this boot, but the
/// control socket still answers `status` (mode + empty peers) so callers get
/// a clear "disabled" answer instead of a hung connection. Never blocks the
/// container's own boot either way, matching this repo's "warn, don't fail"
/// convention for pre-exec daemons.
async fn run_control_socket_only(cfg: &Config, mode: wg::TunnelMode, mesh_ip: String) {
    let state: control::Shared = Arc::new(RwLock::new(SharedState { mode, mesh_ip, peers: vec![] }));
    let (nudge_tx, _nudge_rx) = mpsc::unbounded_channel::<()>();
    let socket = cfg.control_socket.clone();
    let _ = control::run(socket, state, nudge_tx).await;
}

fn to_wg_peers(peers: &[coordinator::PeerView]) -> Vec<wg::PeerConfig> {
    peers
        .iter()
        .map(|p| wg::PeerConfig {
            public_key: p.public_key.clone(),
            mesh_ip: p.mesh_ip.clone(),
            endpoint_host: p.endpoint_host.clone(),
            endpoint_port: p.endpoint_port,
        })
        .collect()
}

async fn reconcile_loop(
    client: coordinator::Client,
    peer_name: String,
    token: String,
    private_key: String,
    listen_port: u16,
    state: control::Shared,
    mut nudge_rx: mpsc::UnboundedReceiver<()>,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    loop {
        tokio::select! {
            _ = interval.tick() => {},
            got = nudge_rx.recv() => { if got.is_none() { return; } },
        }
        match client.poll(&peer_name, &token).await {
            Ok(peers) => {
                let mesh_ip = state.read().await.mesh_ip.clone();
                if let Err(err) = wg::write_config(&private_key, &mesh_ip, listen_port, &to_wg_peers(&peers), false).await {
                    eprintln!("[mesh-daemon] WARNING: reconcile write_config failed ({err})");
                    continue;
                }
                if let Err(err) = wg::syncconf().await {
                    eprintln!("[mesh-daemon] WARNING: wg syncconf failed ({err})");
                    continue;
                }

                let old_peers = state.read().await.peers.clone();
                let old_names: std::collections::HashSet<_> = old_peers.iter().map(|p| p.name.clone()).collect();
                let new_names: std::collections::HashSet<_> = peers.iter().map(|p| p.name.clone()).collect();

                // `wg syncconf` only ever updates the device's crypto/peer
                // config via netlink — it never touches the routing table
                // (only wg-quick's own `up`/`down` scripts do, and only for
                // whatever peers existed in the config file at that exact
                // moment). A peer introduced later, via this reconcile loop,
                // needs its AllowedIPs route added by hand or packets to it
                // silently fall through to the default route and vanish.
                for peer in &peers {
                    if !old_names.contains(&peer.name) {
                        eprintln!("[mesh-daemon] peer \"{}\" -> {} (via reconcile)", peer.name, peer.mesh_ip);
                        if let Err(err) = wg::add_route(&peer.mesh_ip).await {
                            eprintln!("[mesh-daemon] WARNING: could not add route to \"{}\" ({err})", peer.name);
                        }
                    }
                }
                for peer in &old_peers {
                    if !new_names.contains(&peer.name) {
                        eprintln!("[mesh-daemon] peer \"{}\" removed (via reconcile)", peer.name);
                        if let Err(err) = wg::remove_route(&peer.mesh_ip).await {
                            eprintln!("[mesh-daemon] WARNING: could not remove route to \"{}\" ({err})", peer.name);
                        }
                    }
                }

                let mut s = state.write().await;
                s.peers = peers;
            }
            Err(err) => {
                eprintln!("[mesh-daemon] WARNING: reconcile poll failed ({err}) — keeping last known peer set");
            }
        }
    }
}

/// Parses `ip -4 -o addr show scope global` for this container's own routable
/// IPv4 address — what mesh-coordinator hands out to other peers as this
/// peer's WireGuard Endpoint. Best-effort: falls back to 127.0.0.1 (loopback,
/// unreachable from any real peer, but never blocks boot) if none is found.
async fn detect_endpoint_host() -> Option<String> {
    let output = Command::new("ip")
        .args(["-4", "-o", "addr", "show", "scope", "global"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        // e.g. "3: eth0    inet 172.17.0.2/16 brd 172.17.255.255 scope global eth0"
        if let Some(pos) = line.find("inet ") {
            let rest = &line[pos + 5..];
            if let Some(cidr) = rest.split_whitespace().next() {
                if let Some(ip) = cidr.split('/').next() {
                    return Some(ip.to_string());
                }
            }
        }
    }
    None
}

async fn wait_for_shutdown() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("failed to register SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("failed to register SIGINT handler");
    tokio::select! {
        _ = term.recv() => {},
        _ = int.recv() => {},
    }
}
