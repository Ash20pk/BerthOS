# @berthos/mesh-coordinator

The host-side service for Berth's WireGuard mesh. It gives each sandbox a stable mesh IP, exchanges public keys, and introduces two apps only when each one's `network:peer:<name>` capability names the other.

[Berth](https://github.com/Ash20pk/BerthOS) runs an AI agent's tools in a sandbox. Each tool declares what it may touch in a `berth.yml` manifest, and the Linux kernel enforces it.

```sh
npm install -g @berthos/mesh-coordinator
```

## Usage

```sh
BERTH_MESH_COORDINATOR_HOST=0.0.0.0 berth-mesh-coordinator   # listens on 4875
berth dev --mesh-coordinator=http://host.docker.internal:4875
```

| Env var | Default | What it does |
|---|---|---|
| `BERTH_MESH_COORDINATOR_PORT` | `4875` | Port to listen on |
| `BERTH_MESH_COORDINATOR_HOST` | `127.0.0.1` | Address to bind. Containers usually can't reach the host's loopback, so set `0.0.0.0` or a bridge address |
| `BERTH_MESH_COORDINATOR_DATA_DIR` | `./.berth-mesh-coordinator-data` | SQLite database |
| `BERTH_MESH_COORDINATOR_TLS_CERT`, `_KEY`, `_CA`, `_REQUIRE_CLIENT_CERT` | unset | Serve HTTPS |

To embed it, `createMeshCoordinatorServer({ dataDir, tls?, logger? })` returns a Fastify instance.

The kernel can't tell WireGuard traffic apart per app, so the coordinator's mutual match is what decides which apps can reach each other. Run it somewhere only you control.

## Docs

[Mesh reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/mesh-reference.md) · [TLS](https://github.com/Ash20pk/BerthOS/blob/main/docs/tls-reference.md) · [Repo](https://github.com/Ash20pk/BerthOS)
