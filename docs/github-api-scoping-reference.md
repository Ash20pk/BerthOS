# GitHub API scoping reference

The GitHub proxy lets an app call only the GitHub API endpoints its manifest declares, by HTTP method and path. `github:read:repos` lets an app read a repository; it does not let it read `/user/emails` or open a pull request. Use it for any app that talks to `api.github.com` with a real token.

## Use it

Declare what the app may do, plus the proxy's local port:

```yaml
# berth.yml
capabilities:
  - github:read:repos       # GET /repos/<owner>/<repo>
  - github:write:issues     # POST, PATCH, ... /repos/<owner>/<repo>/issues...
  - network:connect:8092    # the proxy's port; the only outbound port the app needs
```

Route the app's `fetch()` through the proxy at module load:

```ts
import { ProxyAgent, setGlobalDispatcher } from "undici";

if (process.env.BERTH_GITHUB_API_PROXY) {
  setGlobalDispatcher(new ProxyAgent(process.env.BERTH_GITHUB_API_PROXY));
}
```

Node's built-in `fetch()` ignores `HTTPS_PROXY`, which is why the dispatcher is needed. The sandbox also sets `NODE_EXTRA_CA_CERTS` so the app trusts the proxy's certificate; that needs no code. [`apps/github-assistant`](../apps/github-assistant) is a complete example.

## How it works

Telling `GET /repos/o/r` from `POST /repos/o/r/issues` means reading inside the TLS session, so unlike the [egress broker](./egress-broker-reference.md) this proxy decrypts:

1. When an app declares any `github:*` capability, the sandbox starts the proxy on `127.0.0.1:8092`. It generates its own CA and a certificate for `api.github.com`, and the sandbox exports `BERTH_GITHUB_API_PROXY` and `NODE_EXTRA_CA_CERTS` for the app.
2. The app connects to `api.github.com` through the proxy. The proxy accepts only that host and terminates TLS itself.
3. It maps the request to a capability: `GET` and `HEAD` are `read`, every other method is `write`, and the path is looked up in a route table.
4. If a declared capability covers it, the proxy opens its own TLS connection to the real `api.github.com`, forwards the request with the app's headers, and streams the response back. If not, it returns `403` and GitHub is never contacted.

## Which paths map to which scope

Paths are normalized first (`.` and `..` resolved), and the normalized path is what gets forwarded. The first matching route wins:

| Path | Scope |
|---|---|
| `/repos/<owner>/<repo>` | `repos` |
| `/repos/<owner>/<repo>/<sub>/...` | `<sub>` (e.g. `issues`, `pulls`, `contents`) |
| `/user` | `user` |
| `/user/<sub>/...` | `user:<sub>` (e.g. `user:emails`) |
| `/users/<name>` | `users` |
| `/users/<name>/<sub>/...` | `users:<sub>` |
| `/orgs/<org>` | `orgs` |
| `/orgs/<org>/<sub>/...` | `orgs:<sub>` |
| `/gists...` | `gists` |
| `/notifications...` | `notifications` |
| `/search/<kind>` | `search:<kind>` |

So `GET /repos/o/r/pulls` needs `github:read:pulls`, and `github:read:user` does not cover `/user/emails`. Scopes are globs: `github:read:*` covers every routed read.

Denied outright, whatever you declare:

- Any path not in the table (for example `/emojis`).
- A `..` that climbs above the root, an encoded `/` or `\` in a segment, or a malformed `%` escape.

## Reference

| Variable | Set by | Meaning |
|---|---|---|
| `BERTH_GITHUB_API_PROXY` | the sandbox | `http://127.0.0.1:<port>`. Pass it to `ProxyAgent`. |
| `NODE_EXTRA_CA_CERTS` | the sandbox | Path to the proxy's CA certificate, `/run/berth/github-api-broker/ca.crt`. |
| `BERTH_GITHUB_API_BROKER_PORT` | you, optional | Port the proxy listens on. Default `8092`. Declare the matching `network:connect:<port>`. |

Responses from the proxy itself:

| Status | Body | When |
|---|---|---|
| `403` | `{"message":"denied: no declared capability covers github:<action>:<scope>"}` | The route matched but nothing declared covers it |
| `403` | `{"message":"denied: no route covers <METHOD> <path> ..."}` | The path isn't in the route table |
| `403` | (none) | `CONNECT` to any host other than `api.github.com` |
| `400` | `this broker only accepts CONNECT requests` | A plain HTTP request instead of `CONNECT` |
| `502` | `bad gateway` | The upstream request to GitHub failed |

Each decision is logged to stderr as JSON with `event` (`allowed`, `denied`, `connect_denied`), `method`, `path` and `requested`.

## The CA the app trusts

`NODE_EXTRA_CA_CERTS` applies to every TLS connection the app makes, not only to GitHub, because Node has no per-host trust setting. The CA is generated fresh for each boot, is valid for two days, and its private key is readable by root only. The certificate directory is readable by the one app told to trust it.

## Using it with the egress broker

An app can declare `github:*` and a host capability such as `browser:navigate:*.github.com` together; `github-assistant` does. The egress broker then refuses `api.github.com`, so a broad host pattern can't bypass the method and path checks. Every other host works as declared.

## In a microVM

`--runtime vm` runs the same broker, with three differences, all made by berth-init (`packages/vmm/init/src/main.rs`, `start_github`):

- **It isn't root.** It runs as `berth-github` (uid 9003) under agent-init: Landlock lets it write only its CA directory and its own scratch directory, and bind only port 8092; it may make no TCP connection at all.
- **Its upstream is the host dialer.** The guest has no network. The broker asks berth-init's relay at `/run/berth/egress/dial.sock` (as a member of the egress group) for a tunnel to `api.github.com:443`, and the host dialer in berth-vmm checks that against its own allowlist, to which the CLI adds `api.github.com:443` for a `github:*` app. TLS to GitHub is the broker's own, over that tunnel, with Node's normal certificate checks.
- **It reads the app's policy from `BERTH_GITHUB_API_POLICY`,** a root-owned copy, because under agent-init `BERTH_CAPABILITY_POLICY` is the broker's own.

As in a container, one app per sandbox may declare `github:*`, and only that app gets `BERTH_GITHUB_API_PROXY` and `NODE_EXTRA_CA_CERTS`. `packages/vmm/scripts/e2e.mjs github` checks it against the real API with a fake token: `DELETE /repos/...` and `GET /user/emails` get the broker's own 403 and are never forwarded; `GET /repos/...` and `POST .../issues` reach GitHub, which answers 401.

## What's deliberately out of scope

- **Single-app sandboxes only.** The proxy doesn't start for a `github:*` app in a multi-app sandbox.
- **GitHub only, and only the routes above.** There is no general method-and-path scoping for other APIs, and GitHub endpoints outside the table are denied. Generalising this to other APIs is on the [roadmap](../ROADMAP.md#next).
- **The real `api.github.com` only.** There's no supported way to point the proxy at GitHub Enterprise or another upstream.
