use serde::Deserialize;
use std::env;

/// Only the one field mesh-daemon needs out of the same capability-policy.json
/// agent-init reads (see @berth/sdk's generate-capability-policy.ts) — serde
/// ignores every other field by default (no deny_unknown_fields), so this
/// stays correct even as that file gains fields for other consumers.
#[derive(Deserialize, Default)]
struct CapabilityPolicyMeshFields {
    #[serde(rename = "meshPeers", default)]
    mesh_peers: Vec<String>,
}

pub struct Config {
    pub peer_name: String,
    pub coordinator_url: String,
    pub control_socket: String,
    pub listen_port: u16,
    pub key_path: String,
    pub token_path: String,
    pub mesh_peer_patterns: Vec<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let policy_path =
            env::var("BERTH_CAPABILITY_POLICY").unwrap_or_else(|_| ".berth/capability-policy.json".to_string());
        let mesh_peer_patterns = std::fs::read_to_string(&policy_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<CapabilityPolicyMeshFields>(&raw).ok())
            .map(|p| p.mesh_peers)
            .unwrap_or_default();

        Config {
            peer_name: env::var("BERTH_MESH_PEER_NAME").unwrap_or_else(|_| "unknown-peer".to_string()),
            coordinator_url: env::var("BERTH_MESH_COORDINATOR_URL")
                .unwrap_or_else(|_| "http://host.docker.internal:4875".to_string()),
            control_socket: env::var("BERTH_MESH_SOCKET").unwrap_or_else(|_| "/tmp/berth-mesh.sock".to_string()),
            listen_port: env::var("BERTH_MESH_LISTEN_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(51820),
            key_path: env::var("BERTH_MESH_KEY_PATH").unwrap_or_else(|_| "/var/berth/mesh/privatekey".to_string()),
            token_path: env::var("BERTH_MESH_TOKEN_PATH").unwrap_or_else(|_| "/var/berth/mesh/owner-token".to_string()),
            mesh_peer_patterns,
        }
    }
}
