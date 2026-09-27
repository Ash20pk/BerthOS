# TLS reference

The app registry and the mesh coordinator serve plain HTTP unless you give them a certificate. Turn TLS on whenever one is reachable from another machine, because clients send tokens to it.

## Turn it on

Point the server at a certificate and key:

```bash
BERTH_REGISTRY_TLS_CERT=/etc/berth/server.crt \
BERTH_REGISTRY_TLS_KEY=/etc/berth/server.key \
berth-registry
```

The server prints the scheme it bound. `listening on https://...` confirms TLS is on.

Each server reads the same variables under its own prefix:

| Server | Prefix |
|---|---|
| `berth-registry` | `BERTH_REGISTRY` |
| `berth-mesh-coordinator` | `BERTH_MESH_COORDINATOR` |

| Variable | Meaning |
|---|---|
| `<PREFIX>_TLS_CERT` | Path to the certificate (PEM) |
| `<PREFIX>_TLS_KEY` | Path to the private key (PEM) |
| `<PREFIX>_TLS_CA` | CA to verify client certificates against (mTLS) |
| `<PREFIX>_TLS_REQUIRE_CLIENT_CERT` | `1` or `true` to require a client certificate |

A partial configuration refuses to start rather than falling back to HTTP: a certificate without a key, a key without a certificate, a path that can't be read, a CA or client-certificate requirement without a certificate and key, or a client-certificate requirement without a CA.

Embedding a server: pass `tls: resolveServerTls({ certPath, keyPath })` (from `@berthos/tls`) to `createRegistryServer()` or `createMeshCoordinatorServer()`. It returns `undefined`, meaning plain HTTP, when nothing is set. `resolveServerTlsFromEnv(prefix)` reads the variables above.

## Certificates for development

```bash
berth tls init
berth tls init --host registry.internal --host 10.0.0.7
```

This creates a local CA and a server certificate, then prints the variables and client flags that use them. It needs `openssl` on your `PATH`.

| Flag | Default | Meaning |
|---|---|---|
| `--dir` | `~/.berth/tls` | Where to write the files. Created `0700`; keys are `0600`. |
| `--host` | `localhost`, `127.0.0.1`, `::1` | Hostname or IP the certificate is valid for. Repeatable. |
| `--days` | `365` | Certificate lifetime. |
| `--force` | off | Regenerate even if certificates already exist. |

Files written: `ca.crt`, `ca.key`, `server.crt`, `server.key`.

Use these for development and closed networks only. For a server reachable from a network you don't control, use a certificate from a real CA.

## Clients

```bash
berth publish --registry https://registry.internal:4873 --ca /path/to/ca.crt
berth init --registry https://registry.internal:4873 --ca /path/to/ca.crt
```

| Flag | Meaning |
|---|---|
| `--ca <path>` | Trust this CA certificate, for example the one `berth tls init` made. Not needed for a certificate from a public CA. |
| `--insecure` | Skip certificate verification. The connection is encrypted but not authenticated, so anyone on the path can intercept it. Prints a warning every time. Use `--ca` instead. |

`NODE_EXTRA_CA_CERTS=/path/to/ca.crt` does the same job as `--ca` and covers every TLS client in the process.

`berth publish` warns when it is about to send a registry owner token over plain HTTP to a host other than `localhost`, `127.0.0.1` or `::1`:

```
[berth] WARNING: sending a registry owner token to http://registry.internal:4873 over plain HTTP — it crosses the network in the clear. Use https:// (see docs/tls-reference.md).
```

## The RPC bridge

The HTTP RPC bridge a deployed sandbox exposes serves HTTPS when `BERTH_HTTP_RPC_TLS_CERT` and `BERTH_HTTP_RPC_TLS_KEY` (file paths, not PEM contents) are both set in the container. Setting only one refuses to start. The bearer token is required either way.

Whether you need it depends on how the port is exposed:

| Exposure | Already TLS? |
|---|---|
| E2B host, Daytona preview link | Yes. The provider terminates TLS in front of the bridge. |
| Kubernetes NodePort, a raw port mapping | No. The bearer token crosses the network in the clear. |

## Limits

- **mTLS has no clients.** The servers can require client certificates, but no Berth client presents one, so turning it on locks out `berth publish` and `berth init`.
- **One port, one scheme.** A server with TLS serves only HTTPS on its port. There is no HTTP listener and no redirect.
- **No certificate reloading.** Restart the server after renewing a certificate.
- **Node's defaults** apply for ciphers, curves and minimum TLS version.
- **Local sockets don't use TLS.** The context bus, the semantic-fs control socket and peer RPC use Unix sockets, protected by file permissions and per-app uids (see [threat model](./threat-model.md)).
