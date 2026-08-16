# TLS reference

Every Berth server can serve HTTPS. None of them do by default.

That default is deliberate — turning TLS on for existing local deployments would break them for no gain on loopback — but it means enabling it is a decision someone has to make, and this file is what that decision needs. Before this existed there was no option at all: `REMEDIATION.md` 5.3 recorded plain HTTP everywhere, a CLI that hardcoded `http://127.0.0.1:4874` and sent an operator token over it, and `berth deploy --grants-server` requiring a URL reachable *from the fleet* — so capability approvals crossing a real network in the clear.

## Turning it on

Every server reads the same four variables under its own prefix:

| Server | Prefix |
|---|---|
| `berth-grants` | `BERTH_GRANTS` |
| `berth-registry` | `BERTH_REGISTRY` |
| `berth-mesh-coordinator` | `BERTH_MESH_COORDINATOR` |

- `<PREFIX>_TLS_CERT` — path to the certificate (PEM)
- `<PREFIX>_TLS_KEY` — path to the private key (PEM)
- `<PREFIX>_TLS_CA` — CA used to verify *client* certificates, for mTLS
- `<PREFIX>_TLS_REQUIRE_CLIENT_CERT` — `1`/`true` to require one

```
BERTH_GRANTS_TLS_CERT=/etc/berth/server.crt \
BERTH_GRANTS_TLS_KEY=/etc/berth/server.key \
berth-grants
```

The server prints the scheme it actually bound, so `listening on https://…` is the confirmation.

**A half-configured pair is a hard error, not a fallback.** A cert with no key, or a path that can't be read, refuses to start. Falling back to plain HTTP there would hand someone a deployment that believes it has TLS and doesn't, which is worse than never offering the option.

Embedding: `createGrantsServer({ tls: resolveServerTls({ certPath, keyPath }) })`. `resolveServerTls` returns `undefined` when nothing is set, which is what keeps the "TLS if configured" shape identical across all three servers.

## Certificates for development

```
berth tls init
```

Mints a local CA and a server certificate under `~/.berth/tls` (keys 0600, directory 0700) and prints the env vars and `--ca` invocation to use them. `--host` is repeatable and defaults to `localhost`, `127.0.0.1`, and `::1`; hosts are tagged `DNS:` or `IP:` in the SAN correctly, which matters because a `DNS:127.0.0.1` entry is accepted by openssl and then never matches anything.

**These are for development and closed internal networks.** A self-signed CA has to be explicitly trusted by every client, and that friction is exactly what leads to verification being switched off instead. For anything reachable from a network you don't control, get a certificate from a real CA and point `_TLS_CERT`/`_TLS_KEY` at it — none of `berth tls init` is involved in that path.

## Clients

```
berth grants list   --server https://grants.internal:4874 --ca /path/to/ca.crt
berth grants approve <id> --server https://grants.internal:4874 --ca /path/to/ca.crt
berth publish --registry https://registry.internal:4873 --ca /path/to/ca.crt
berth init --registry https://registry.internal:4873 --ca /path/to/ca.crt
```

`--ca` is only needed for a CA outside the system trust store. A certificate from a real CA needs no flag at all.

`NODE_EXTRA_CA_CERTS=/path/to/ca.crt` does the same job without a flag and covers every TLS client in the process rather than just `fetch`. Prefer it where you can set an environment variable.

`--insecure` exists, warns on every use, and is not a way to run anything permanently. A client that skips verification completes the handshake and gets none of the guarantee — encrypted, unauthenticated, and interceptable by anything on the path. It looks secure, which is the problem.

### The plaintext warning

Commands that send a credential — `berth grants approve/deny`, `berth publish`, and `berth deploy --grants-server` — warn when the target is plain HTTP on a non-loopback host:

```
[berth] WARNING: sending an operator token to http://grants.internal:4874 over plain HTTP — it crosses the network in the clear.
```

Loopback is exempt because nothing crosses a network there. Warning about it would be noise, and noise is how people learn to ignore the warning that matters.

## The RPC bridge

`@berth/sdk`'s `startHttpRpcServer` (the bridge a deployed fleet instance exposes) takes a `tls` option, set from `BERTH_HTTP_RPC_TLS_CERT` / `BERTH_HTTP_RPC_TLS_KEY` — paths, deliberately, not PEMs in the environment, where they would sit in `docker inspect` beside the bearer token.

Whether you need it depends on how the port is exposed:

| Exposure | Already TLS? |
|---|---|
| E2B `getHost`, Daytona preview link | Yes — the provider terminates in front, and the bridge is only reachable through their proxy |
| K8s NodePort, a raw port mapping | No — the port is handed out directly and the bearer token crosses in the clear |

TLS is not a substitute for the token, and the bridge still requires it either way.

## mTLS

Server-side support exists: set `<PREFIX>_TLS_CA` and `<PREFIX>_TLS_REQUIRE_CLIENT_CERT=1` and the server demands a client certificate signed by that CA.

**No client in this repo presents one.** It is the right control for service-to-service traffic and the wrong thing to impose on an operator running `berth grants approve` from a laptop — there is no CA to issue them a certificate from, because no identity system exists yet (`REMEDIATION.md` 5.2). Turning this on today locks out every first-party client.

## What is still open

- **No client certificates anywhere**, per above.
- **No HTTPS by default**, and no redirect from HTTP — a server configured for TLS serves TLS on its one port and nothing listens on plain HTTP to redirect from.
- **No certificate reloading.** A renewed certificate needs a server restart.
- **No cipher, curve, or minimum-version pinning** — Node's defaults apply.
- **`POST /grants` is unauthenticated** regardless of transport. TLS protects it in flight; it does not make the requester known.
- **The context bus, semantic-fs control socket, and peer RPC sockets are Unix sockets**, not TCP, so TLS does not apply. They are protected by filesystem permissions and `SO_PEERCRED` (see [per-app uid design](./per-app-uid-design.md)).
