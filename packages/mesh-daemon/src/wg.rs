use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub const INTERFACE: &str = "wg0";
pub const CONFIG_PATH: &str = "/etc/wireguard/wg0.conf";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TunnelMode {
    Kernel,
    Userspace,
}

impl TunnelMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            TunnelMode::Kernel => "kernel",
            TunnelMode::Userspace => "userspace",
        }
    }
}

pub struct Keypair {
    pub private_key: String,
    pub public_key: String,
}

async fn run_capturing(program: &str, args: &[&str], stdin_input: Option<&str>) -> io::Result<String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if stdin_input.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = cmd.spawn()?;

    if let Some(input) = stdin_input {
        let mut stdin = child.stdin.take().expect("stdin was piped");
        stdin.write_all(input.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        drop(stdin);
    }

    let output = child.wait_with_output().await?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "{program} {args:?} exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Loads the persisted private key at `key_path`, or generates + persists a
/// new one on first boot. Not carried across a fresh container recreation
/// unless that path happens to be volume-mounted — a known, documented gap
/// (see docs/mesh-reference.md), not something this session solves.
pub async fn load_or_generate_keypair(key_path: &str) -> io::Result<Keypair> {
    let private_key = match tokio::fs::read_to_string(key_path).await {
        Ok(existing) => existing.trim().to_string(),
        Err(_) => {
            let generated = run_capturing("wg", &["genkey"], None).await?;
            if let Some(parent) = Path::new(key_path).parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::write(key_path, format!("{generated}\n")).await?;
            tokio::fs::set_permissions(key_path, std::fs::Permissions::from_mode(0o600)).await?;
            generated
        }
    };
    let public_key = run_capturing("wg", &["pubkey"], Some(&private_key)).await?;
    Ok(Keypair { private_key, public_key })
}

/// Probes whether the kernel has the `wireguard` netdevice type available by
/// actually trying to create one — the only reliable way to know, short of
/// parsing `/proc/modules`/`lsmod` output which varies by distro. Cleans up
/// the probe link immediately on success. Failure here is expected and
/// routine (e.g. Docker Desktop for Mac's linuxkit VM, or any guest kernel
/// without the module loaded) — same class of environment gap as this
/// repo's existing Landlock-on-Docker-Desktop-for-Mac caveat.
pub async fn probe_kernel_support() -> TunnelMode {
    match Command::new("ip")
        .args(["link", "add", "wg0-probe", "type", "wireguard"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
    {
        Ok(status) if status.success() => {
            let _ = Command::new("ip")
                .args(["link", "del", "wg0-probe"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
            TunnelMode::Kernel
        }
        _ => TunnelMode::Userspace,
    }
}

pub struct PeerConfig {
    pub public_key: String,
    pub mesh_ip: String,
    pub endpoint_host: String,
    pub endpoint_port: u16,
}

/// Writes /etc/wireguard/wg0.conf. `include_address` must be true for the
/// initial `wg-quick up` (wg-quick's own config format understands `Address
/// =` and turns it into `ip address add` itself) and false for every
/// subsequent `wg syncconf` reconcile tick — `wg syncconf`/`wg setconf` read
/// the lower-level wg(8) config format directly, which has no `Address` key
/// at all and fails to parse the whole file if it's present (confirmed
/// against a real `wg syncconf` run: "Line unrecognized: `Address=...'").
/// The interface's address is only ever set once, at bring-up; reconcile
/// ticks only ever change the peer list.
pub async fn write_config(private_key: &str, own_mesh_ip: &str, listen_port: u16, peers: &[PeerConfig], include_address: bool) -> io::Result<()> {
    let mut conf = format!("[Interface]\nPrivateKey = {private_key}\nListenPort = {listen_port}\n");
    if include_address {
        conf.push_str(&format!("Address = {own_mesh_ip}/32\n"));
    }
    for peer in peers {
        conf.push_str(&format!(
            "\n[Peer]\nPublicKey = {}\nAllowedIPs = {}/32\nEndpoint = {}:{}\n",
            peer.public_key, peer.mesh_ip, peer.endpoint_host, peer.endpoint_port
        ));
    }
    if let Some(parent) = Path::new(CONFIG_PATH).parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(CONFIG_PATH, conf).await?;
    tokio::fs::set_permissions(CONFIG_PATH, std::fs::Permissions::from_mode(0o600)).await?;
    Ok(())
}

fn userspace_env(mode: TunnelMode) -> Vec<(&'static str, &'static str)> {
    match mode {
        TunnelMode::Kernel => vec![],
        // wg-quick's own documented fallback mechanism (not a Berth
        // invention) — dispatches every kernel-interface operation to this
        // binary instead of netlink. Requires boringtun-cli baked into the
        // image (see docker/base.Dockerfile's boringtun-builder stage).
        TunnelMode::Userspace => vec![("WG_QUICK_USERSPACE_IMPLEMENTATION", "boringtun-cli")],
    }
}

async fn wg_quick(mode: TunnelMode, action: &str) -> io::Result<()> {
    let mut cmd = Command::new("wg-quick");
    cmd.args([action, INTERFACE]);
    for (k, v) in userspace_env(mode) {
        cmd.env(k, v);
    }
    let status = cmd.status().await?;
    if !status.success() {
        return Err(io::Error::other(format!("wg-quick {action} {INTERFACE} exited with {status}")));
    }
    Ok(())
}

pub async fn up(mode: TunnelMode) -> io::Result<()> {
    wg_quick(mode, "up").await
}

pub async fn down(mode: TunnelMode) -> io::Result<()> {
    wg_quick(mode, "down").await
}

/// Live-diffs the interface's peer list against CONFIG_PATH's current
/// contents without bouncing the interface — the standard WireGuard
/// reconcile primitive, so this daemon needs no custom diffing logic itself
/// for the crypto/peer config. It does NOT touch the kernel routing table,
/// though — that's `wg-quick`'s own doing (at `up` time only, for whatever
/// peers exist in the config file at that exact moment), so a peer added
/// later via a `syncconf` call has no AllowedIPs route unless something adds
/// one explicitly — see add_route/remove_route below, called by main.rs's
/// reconcile loop for exactly this reason (confirmed against a real run:
/// without this, packets to a peer introduced after initial bring-up fall
/// through to the default route and silently vanish).
pub async fn syncconf() -> io::Result<()> {
    let status = Command::new("wg").args(["syncconf", INTERFACE, CONFIG_PATH]).status().await?;
    if !status.success() {
        return Err(io::Error::other(format!("wg syncconf {INTERFACE} exited with {status}")));
    }
    Ok(())
}

/// Best-effort: "already exists" (peer was present since initial `wg-quick
/// up`, which already added this route) is not an error worth surfacing.
pub async fn add_route(mesh_ip: &str) -> io::Result<()> {
    let _ = Command::new("ip")
        .args(["-4", "route", "add", &format!("{mesh_ip}/32"), "dev", INTERFACE])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await?;
    Ok(())
}

pub async fn remove_route(mesh_ip: &str) -> io::Result<()> {
    let _ = Command::new("ip")
        .args(["-4", "route", "del", &format!("{mesh_ip}/32"), "dev", INTERFACE])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await?;
    Ok(())
}
