use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Deserialize, Clone, Debug)]
pub struct PeerView {
    pub name: String,
    #[serde(rename = "meshIp")]
    pub mesh_ip: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
    #[serde(rename = "endpointHost")]
    pub endpoint_host: String,
    #[serde(rename = "endpointPort")]
    pub endpoint_port: u16,
}

#[derive(Deserialize)]
struct RegisterResponseWire {
    #[serde(rename = "meshIp")]
    mesh_ip: String,
    #[serde(rename = "ownerToken")]
    owner_token: Option<String>,
    peers: Vec<PeerView>,
}

pub struct RegisterResponse {
    pub mesh_ip: String,
    pub owner_token: Option<String>,
    pub peers: Vec<PeerView>,
}

#[derive(Serialize)]
struct RegisterBody<'a> {
    name: &'a str,
    #[serde(rename = "publicKey")]
    public_key: &'a str,
    #[serde(rename = "endpointHost")]
    endpoint_host: &'a str,
    #[serde(rename = "endpointPort")]
    endpoint_port: u16,
    #[serde(rename = "meshPeerPatterns")]
    mesh_peer_patterns: &'a [String],
}

#[derive(Deserialize)]
struct PeersResponseWire {
    peers: Vec<PeerView>,
}

/// What a poll can mean: either the coordinator answered with the (possibly
/// empty) mutual-match roster, or it no longer has any record of this peer
/// at all (a 404) — e.g. the coordinator restarted without its data
/// directory intact. The two need different handling: an ordinary error
/// (network blip, 500) is safe to just retry on the next tick, but a 404
/// means re-registering is the only way this peer is ever seen again —
/// silently retrying the same poll forever never recovers.
pub enum PollOutcome {
    Peers(Vec<PeerView>),
    NotFound,
}

pub struct Client {
    http: reqwest::Client,
    base_url: String,
}

impl Client {
    pub fn base_url_for_log(&self) -> &str {
        &self.base_url
    }

    pub fn new(base_url: String) -> Self {
        let http = reqwest::Client::builder()
            // Without a request timeout, a single stuck connection (observed
            // in CI, not reproduced locally — a native Linux Docker bridge
            // vs. this repo's own macOS dev environment's virtualized
            // networking is the likely difference) hangs the reconcile loop
            // forever, since nothing here ever times out on its own and the
            // 5s interval never gets a chance to retry. Bounding every
            // request means a hung one just becomes a logged WARNING and the
            // next tick tries fresh, instead of the mesh silently freezing.
            .timeout(std::time::Duration::from_secs(5))
            // Disables keep-alive connection reuse — a fresh TCP connection
            // per request costs little at this call volume (one every 5s)
            // and rules out a stale pooled connection as a hang source.
            .pool_max_idle_per_host(0)
            .build()
            // Falls back rather than panicking: a panic here would happen
            // inside a spawned tokio task (the reconcile loop's own client)
            // with no JoinHandle ever awaited to surface it — the task would
            // just silently vanish, indistinguishable from a hang. Untuned
            // defaults (no timeout, normal pooling) are still strictly
            // better than that.
            .unwrap_or_else(|err| {
                eprintln!("[mesh-daemon] WARNING: custom HTTP client build failed ({err}) — falling back to reqwest defaults");
                reqwest::Client::new()
            });
        Client { http, base_url }
    }

    fn authed(&self, builder: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
        match token {
            Some(t) => builder.bearer_auth(t),
            None => builder,
        }
    }

    /// First registration of a name needs no token (returns one, minted by
    /// the coordinator). Re-registering an existing name without presenting
    /// that same token is rejected — see mesh-coordinator's routes.ts.
    pub async fn register(
        &self,
        name: &str,
        public_key: &str,
        endpoint_host: &str,
        endpoint_port: u16,
        mesh_peer_patterns: &[String],
        token: Option<&str>,
    ) -> Result<RegisterResponse> {
        let body = RegisterBody { name, public_key, endpoint_host, endpoint_port, mesh_peer_patterns };
        let req = self.http.post(format!("{}/peers", self.base_url)).json(&body);
        let res = self.authed(req, token).send().await?;
        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(format!("mesh-coordinator register failed ({status}): {text}").into());
        }
        let wire: RegisterResponseWire = res.json().await?;
        Ok(RegisterResponse { mesh_ip: wire.mesh_ip, owner_token: wire.owner_token, peers: wire.peers })
    }

    /// The 5s reconcile poll — returns exactly the mutual-match-filtered
    /// roster the coordinator has decided this peer is authorized to see,
    /// or `PollOutcome::NotFound` if the coordinator has no record of this
    /// peer at all (see `PollOutcome`'s own doc comment).
    pub async fn poll(&self, name: &str, token: &str) -> Result<PollOutcome> {
        let req = self.http.get(format!("{}/peers?name={name}", self.base_url)).bearer_auth(token);
        let res = req.send().await?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(PollOutcome::NotFound);
        }
        if !res.status().is_success() {
            let status = res.status();
            return Err(format!("mesh-coordinator poll failed ({status})").into());
        }
        let wire: PeersResponseWire = res.json().await?;
        Ok(PollOutcome::Peers(wire.peers))
    }

    /// Best-effort — a failure here just leaves a stale row the coordinator
    /// will still hand out until this name is registered again with the same
    /// token (or never, if the container never comes back).
    pub async fn deregister(&self, name: &str, token: &str) -> Result<()> {
        let req = self.http.delete(format!("{}/peers/{name}", self.base_url)).bearer_auth(token);
        let _ = req.send().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// A minimal one-shot raw-TCP HTTP server: accepts exactly one
    /// connection, ignores the request, and writes back the given
    /// status/body. No mock-HTTP crate needed for a canned single response.
    async fn serve_once(status_line: &'static str, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local_addr");
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            let response = format!("{status_line}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}", body.len());
            let _ = socket.write_all(response.as_bytes()).await;
        });
        format!("http://{addr}")
    }

    /// Regression test for the fix: poll() must distinguish a 404 (the
    /// coordinator has no record of this peer — reconcile_loop needs to
    /// re-register) from an ordinary success, not collapse both into the
    /// same "here are the peers" shape.
    #[tokio::test]
    async fn poll_returns_not_found_outcome_on_a_404() {
        let base_url = serve_once("HTTP/1.1 404 Not Found", r#"{"error":"no peer named \"x\""}"#).await;
        let client = Client::new(base_url);

        let outcome = client.poll("x", "tok").await.expect("poll should not error on a 404");
        assert!(matches!(outcome, PollOutcome::NotFound));
    }

    #[tokio::test]
    async fn poll_returns_peers_outcome_on_success() {
        let base_url = serve_once("HTTP/1.1 200 OK", r#"{"peers":[]}"#).await;
        let client = Client::new(base_url);

        let outcome = client.poll("x", "tok").await.expect("poll should succeed");
        match outcome {
            PollOutcome::Peers(peers) => assert!(peers.is_empty()),
            PollOutcome::NotFound => panic!("expected Peers, got NotFound"),
        }
    }

    #[tokio::test]
    async fn poll_returns_an_error_for_a_non_404_failure_status() {
        let base_url = serve_once("HTTP/1.1 500 Internal Server Error", r#"{"error":"boom"}"#).await;
        let client = Client::new(base_url);

        let result = client.poll("x", "tok").await;
        assert!(result.is_err(), "a 500 should still be a plain error, not NotFound or success");
    }
}
