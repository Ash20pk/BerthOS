# Egress broker reference

The egress broker is a small HTTP proxy inside the sandbox that lets an app reach only the hostnames its manifest declares. Use it when an app needs to browse or call an HTTP API on specific hosts. The kernel can scope outbound traffic by port but not by hostname, so this part is enforced by the proxy.

## Context

An app that declares `network:host:<pattern>` (or `browser:navigate:<pattern>`, the same capability under a browser's name) reaches the internet only through the broker. The kernel holds the other half: the broker's port is the app's only outbound grant, so traffic can't go around it. Anything that isn't a declared host, and any internal address, is refused.

For the GitHub API, a separate [GitHub proxy](./github-api-scoping-reference.md) enforces methods and paths, not just the host. For how this sits among the rest of Berth, see the [README](../README.md#level-3-components-inside-a-sandbox).

## Containers

<p align="center"><img src="./images/c4/egress-broker.svg" alt="Egress broker containers: the resident app sends CONNECT host:port to the egress broker on 127.0.0.1:8090; the kernel refuses every other outbound port. In a container the broker dials allowed hosts directly; in a microVM it hands allowed connections over vsock 1026 to a dialer in berth-vmm on the host, which checks them again before dialling." width="100%"></p>

### How it works

When an app declares `browser:navigate:*` or `network:host:*`, the sandbox starts the broker on `127.0.0.1:8090` and sets `BERTH_EGRESS_PROXY_URL` for the app. The broker reads the app's declared host patterns from its compiled capability policy.

For HTTPS, the app sends `CONNECT host:port`, which names the target in cleartext. The broker checks the host and port, then either tunnels the encrypted bytes through untouched or refuses. It never decrypts anything. Plain `http://` requests get the same check.

Keep the broker's port as the app's only `network:connect` grant. The kernel then blocks every other outbound port, so traffic can't go around the broker.

In a [microVM sandbox](./local-vm.md) the guest has no network device. The broker hands each allowed connection over vsock to a dialer in `berth-vmm` on the host, which enforces the same allowlist again, resolves names itself and refuses internal addresses. See [the egress design](./design/microvm-egress.md).

## Components

Inside the broker: a pattern matcher for host and port, a resolver that checks the address it will dial, the `CONNECT` tunnel, optional chaining to an upstream proxy, and a JSON decision log on stderr ([Code](#code)).

### What a pattern covers

A scope is a host glob with an optional port: `example.com`, `*.github.com`, `internal-db.corp:5432`, `example.com:*`.

- **Ports.** A pattern with no port covers 80 and 443 only. Name any other port explicitly (`network:host:internal-db.corp:5432`), or use `:*` for any port.
- **Wildcards.** Only `*` is a wildcard. `?` and other characters match literally.
- **Internal addresses are always refused.** Loopback, private ranges (10/8, 172.16/12, 192.168/16), link-local (including the cloud metadata address `169.254.169.254`), CGNAT (100.64/10), `0.0.0.0/8` and multicast are blocked under every pattern, `*` included. So is `host.docker.internal`, which resolves to the Docker host. The check runs on the resolved address, not the name.
- **The checked address is the one dialled.** The broker resolves the name once, checks that address and connects to it, so a DNS answer that changes between check and connect (DNS rebinding) can't slip through.
- **IPv4 only.** Names are resolved to A records.
- **`api.github.com` belongs to the GitHub proxy.** If the app also declares any `github:*` capability, the [GitHub proxy](./github-api-scoping-reference.md) enforces method and path for `api.github.com`, and this broker refuses that host under every pattern. An app with no `github:*` capability reaches it normally.

### Optional: chaining through an upstream proxy (e.g. residential)

Some sites block or challenge traffic from datacenter IP ranges. To send allowed traffic out through another proxy, such as a residential proxy provider, set `BERTH_EGRESS_UPSTREAM_PROXY` in the container's environment:

```bash
BERTH_EGRESS_UPSTREAM_PROXY=http://user:pass@residential-proxy.example.com:8000
```

- The host check still runs first. A denied host never reaches the upstream proxy.
- Credentials are optional. When present, the broker sends them as `Proxy-Authorization: Basic ...`. Only `host:port` is ever logged, never the credentials.
- Any provider that accepts plain HTTP `CONNECT` works.
- The upstream proxy does its own DNS resolution, so the internal-address block above can't apply. The host and port check still does.

Routing traffic through a residential network to get past a site's bot detection may break that site's terms of service. That decision is yours.

## Code

### Use it

Declare the hosts the app may reach, plus the broker's local port so the kernel lets the app connect to it:

```yaml
# berth.yml
capabilities:
  - network:host:example.com
  - network:connect:8090      # the broker's port; the only outbound port the app gets
```

Then route the app's `fetch()` through the broker, once, at module load:

```ts
import { configureEgressProxy } from "@berthos/sdk";

configureEgressProxy();   // no-op when no host capability is declared
const res = await fetch("https://example.com/");
```

`browser:navigate:<pattern>` is the same capability under the name a browser app uses. `apps/browser-native` declares `browser:navigate:*` and points Chromium at the broker with its `--proxy-server` launch option instead of `configureEgressProxy()`.

Working examples: [`examples/resident-apps/http-fetch`](../examples/resident-apps/http-fetch) (plain `fetch()`) and [`examples/resident-apps/generic-connector`](../examples/resident-apps/generic-connector), which uses `defineConnectorApp()` from the SDK ([reference](./sdk-reference.md#defineconnectorappconfig-a-resident-app-from-a-declarative-rest-api-description)).

### Reference

| Variable | Set by | Meaning |
|---|---|---|
| `BERTH_EGRESS_PROXY_URL` | the sandbox | `http://127.0.0.1:<port>`. Read by `configureEgressProxy()`. Unset when no host capability is declared. |
| `BERTH_EGRESS_BROKER_PORT` | you, optional | Port the broker listens on. Default `8090`. Declare the matching `network:connect:<port>`. |
| `BERTH_EGRESS_UPSTREAM_PROXY` | you, optional | Upstream proxy URL to chain allowed connections through. |

Responses:

| Status | When |
|---|---|
| `403` | Host or port not covered by a declared pattern, address is internal, or the host is owned by the GitHub proxy |
| `502` | The name didn't resolve, the connection failed, or the upstream proxy refused |
| `400` | A plain request without an absolute URL (not a proxy request) |

The broker logs each decision to stderr as JSON, for example `{"event":"navigate_denied","host":"...","port":443,"viaUpstreamProxy":false}`. Other events: `navigate_allowed`, `blocked_address`, `dedicated_broker_host`.

The broker itself is [`packages/docker-orchestrator/docker/egress-broker.cjs`](../packages/docker-orchestrator/docker/egress-broker.cjs).

## Limits

- **One broker per sandbox.** In a multi-app sandbox, only one app may declare `browser:navigate:*` or `network:host:*`. `berth dev` and `berth os up` refuse to boot more than one.
- **The kernel grant is port-only.** `network:connect:8090` allows port 8090 on any address, not just the broker. The broker's own checks are what enforce the hostname.
- **Hostnames only, not paths or methods.** For per-endpoint scoping of the GitHub API, see the [GitHub proxy](./github-api-scoping-reference.md).
