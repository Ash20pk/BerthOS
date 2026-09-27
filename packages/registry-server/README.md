# @berthos/registry-server

A small, self-hosted registry for sharing resident apps inside a team or on a closed network. `berth publish` uploads an app to it, and `berth init --registry` starts a new project from one.

[Berth](https://github.com/Ash20pk/BerthOS) runs an AI agent's tools in a sandbox. Each tool declares what it may touch in a `berth.yml` manifest, and the Linux kernel enforces it.

```sh
npm install -g @berthos/registry-server
```

## Usage

```sh
berth-registry                                              # listens on http://127.0.0.1:4873
berth publish --registry http://localhost:4873              # from an app's directory; prints an owner token
berth init my-app --registry http://localhost:4873 --template notes
```

The first publish of a name prints an owner token. Save it: it isn't shown again, and every later version of that name needs it (`--token` or `BERTH_REGISTRY_TOKEN`).

| Env var | Default | What it does |
|---|---|---|
| `BERTH_REGISTRY_PORT` | `4873` | Port to listen on |
| `BERTH_REGISTRY_HOST` | `127.0.0.1` | Address to bind; `0.0.0.0` accepts remote connections |
| `BERTH_REGISTRY_DATA_DIR` | `./.berth-registry-data` | SQLite index and uploaded bundles |
| `BERTH_REGISTRY_TLS_CERT`, `_KEY`, `_CA`, `_REQUIRE_CLIENT_CERT` | unset | Serve HTTPS |

To embed it, `createRegistryServer({ dataDir, tls?, logger? })` returns a Fastify instance; call `.listen()` yourself.

## Limits

- Single node, no users or rate limiting. The only credential is each name's owner token, which can't be recovered or rotated.
- Serve it over HTTPS when it's on another machine, so the owner token isn't sent in the clear.

## Docs

[App registry reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/app-registry-reference.md) · [TLS](https://github.com/Ash20pk/BerthOS/blob/main/docs/tls-reference.md) · [Repo](https://github.com/Ash20pk/BerthOS)
