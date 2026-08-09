# GitHub API Verb/Path Scoping Reference

`packages/docker-orchestrator/docker/github-api-broker.cjs` enforces the distinction between `github:read:<scope>` and `github:write:<scope>` capabilities (e.g. `github:read:repos` vs `github:write:issues`) — the gap `docs/egress-broker-reference.md` and `docs/capability-tokens-reference.md` both named as needing real TLS interception, unlike `browser:navigate:<pattern>`'s host-level-only enforcement.

## Why this needed a genuinely different broker, not an extension of the egress broker

`egress-broker.cjs` enforces host-level scoping with zero TLS interception because a `CONNECT host:port` line is cleartext by protocol design — the proxy only ever needs to see where to open a raw socket, never anything inside the encrypted session. Distinguishing `GET /repos/x/y` from `POST /repos/x/y/issues` requires the actual HTTP method and path, which live inside the TLS-encrypted application data on any real request to `api.github.com` — invisible to a transparent relay.

`github-api-broker.cjs` is a real, if narrowly-scoped, MITM proxy:

1. **Generates its own CA and a leaf certificate for `api.github.com`** at container boot, using the `openssl` CLI (added to `base.Dockerfile`'s apk packages — Node core has no certificate-signing API of its own).
2. **Terminates the TLS connection itself** when it sees a `CONNECT api.github.com:443` — wrapping the raw socket in `tls.TLSSocket({isServer: true, cert, key})` using that leaf cert, so the app's own TLS client (which must trust this CA — see below) completes a real handshake with the broker, believing it's talking to the real GitHub API.
3. **Feeds the decrypted socket into a real `http.Server`** (via `httpServer.emit("connection", tlsSocket)` rather than `.listen()`) to get genuine HTTP request parsing off it, no hand-rolled parser.
4. **Checks the real method + path** against declared `github:read:*`/`github:write:*` capabilities — GET/HEAD map to `read`, everything else to `write`; the path is normalized and then matched against an explicit route table that **denies by default** (see below). Still GitHub-specific, not a general REST-API-aware grammar.
5. **On denial**: responds 403 immediately — the real GitHub API is never contacted.
6. **On allow**: opens a brand-new, real outbound TLS connection to the real `api.github.com` and forwards the request, streaming the real response back. This is a genuine decrypt → decide → re-encrypt round trip.

## What a `github:read:repos` capability actually covers

The first version of the path check was positional: `segments.length > 3 ? segments[3] : "repos"`. Every GET with three or fewer path segments was therefore classified `github:read:repos`, so an app declaring that one capability to read a repo summary also got `/user`, `/user/emails`, `/user/repos`, `/gists`, `/notifications` and `/orgs/<org>` — each forwarded upstream with the app's real `Authorization` header (REMEDIATION.md 1.9).

What replaced it (`ROUTES` in `github-api-broker.cjs`):

- **An explicit table**, path pattern → scope, consulted in order. `/repos/<owner>/<repo>` is `repos`; `/repos/<owner>/<repo>/<sub>` is `<sub>` (`issues`, `pulls`, `contents`, ...); `/user` is `user` and `/user/<sub>` is `user:<sub>`, so `github:read:user` does *not* cover `/user/emails`; `/users/*`, `/orgs/*`, `/gists`, `/notifications` and `/search/<kind>` each get their own scope.
- **Default deny.** A path no route matches is refused with `"requested":"(no route)"` — nothing falls through to a scope. Adding a route is how the covered surface grows; forgetting one costs an app a 403 rather than granting it something nobody declared.
- **Normalization before the check, and the normalized path is what's forwarded.** The path used to be checked and forwarded verbatim (`path: req.url`), so `/repos/o/r/issues/../../../../user/emails` was classified `github:read:issues` here and resolved to `/user/emails` at GitHub's edge. Dot segments are now resolved first; a `..` above the root, an encoded separator (`%2f`), or a malformed escape is denied outright rather than guessed at.

## The CA the app is told to trust

`NODE_EXTRA_CA_CERTS` is process-wide — the app trusts this CA for *every* TLS connection it makes, not just `api.github.com`. That is inherent to the mechanism (Node has no per-host trust knob), which makes the CA's private key worth protecting accordingly:

- The cert directory is `/run/berth/github-api-broker`, not `/tmp` — `/tmp` is world-writable and shared with every other app in a multi-app container.
- The broker creates it `0700` and writes `ca.key`/`leaf.key` `0600`; `entrypoint.sh` then narrows the directory to `0750 root:<app-gid>`, so exactly the one app that was told to trust the CA can traverse it and read `ca.crt`. The keys stay root-only.
- Because that path is outside the `/tmp` the read baseline covers in full, `generate-capability-policy` adds `/run/berth/github-api-broker` to `readPaths` for an app declaring any `github:*` capability — Node reads `NODE_EXTRA_CA_CERTS` at process start, i.e. after `agent-init` has enforced Landlock. Without it, an app that also declares a `filesystem:read:` capability fails the handshake instead.

## The two brokers compose

An app can declare both `github:read:repos` and `network:host:*`/`browser:navigate:*`. It used to get a raw `CONNECT api.github.com:443` through `egress-broker.cjs` as well — no decryption, no path or verb inspection — which is the coarse capability silently undoing the fine one. `apps/github-assistant` is the live case: it declares `browser:navigate:*.github.com` today.

`egress-broker.cjs` now refuses `api.github.com` outright *when the same policy declares a `github:*` capability*, i.e. exactly when `entrypoint.sh` has started the dedicated broker for it. An app with no `github:*` capability has no second broker running and no path-level policy to route around, so `network:host:api.github.com` still works for it — this narrows one host for one kind of app, not the capability.

## How an app actually routes through it

Unlike `browser-native`'s Chromium (which gets an explicit `proxy: {server: ...}` Playwright launch option), `apps/github-assistant` is a plain Node app calling `fetch()` — and Node's built-in fetch (undici) does **not** consult `HTTPS_PROXY`/etc on its own. So:

- `apps/github-assistant` adds a real `undici` dependency and calls `setGlobalDispatcher(new ProxyAgent(process.env.BERTH_GITHUB_API_PROXY))` at module load, when that env var is set (`src/index.ts`).
- `entrypoint.sh`'s single-app path (only — see "What's deliberately out of scope" below) starts the broker whenever `berth.yml` declares any `github:*` capability, waits for its generated CA to appear, then exports `BERTH_GITHUB_API_PROXY=http://127.0.0.1:8092` and `NODE_EXTRA_CA_CERTS=<broker's ca.crt>` before handing off to `agent-init` — the app process inherits both.
- `NODE_EXTRA_CA_CERTS` needs no application code at all — Node's TLS stack reads it automatically at process start, which is what makes the app's `ProxyAgent`-routed TLS handshake with the broker (impersonating `api.github.com`) actually succeed.
- `apps/github-assistant/berth.yml`'s `network:connect:443` was narrowed to `network:connect:8092` (the broker's own local port) — same pattern `apps/browser-native` uses for the egress broker: the kernel only needs to permit reaching the local broker; the broker does the real enforcement.

One real interaction this surfaced: the broker auto-starts whenever `github:*` is declared, but `github-assistant-milestone.mjs`'s original (pre-broker) test bypasses everything via `GITHUB_API_BASE_URL` pointed at a plain-HTTP mock — which the broker's CONNECT-only listener would otherwise 400. `src/index.ts` only calls `setGlobalDispatcher` when `GITHUB_API_BASE_URL` is *not* set, keeping that original test broker-free rather than special-casing plain HTTP inside the broker itself.

## Verification

`packages/docker-orchestrator/test/github-assistant-milestone.mjs` runs three scenarios:

- `runRouteTableScenario()` — the shipped broker script directly, no Docker, since every decision above is made before the request leaves the broker. A declared `/repos/<owner>/<repo>` read is forwarded to a mock upstream (the positive control — every denial below would also "pass" against a broker that had stopped forwarding); `/user/emails` is refused and the denial names `github:read:user:emails` rather than `github:read:repos`; `/user`, `/gists`, `/notifications` and `/orgs/<org>` are refused; a `..` under an allowed prefix is refused after normalization, with nothing containing `..` ever reaching the upstream; `/emojis` is refused as unrouted; and the cert directory and CA key are asserted `0700`/`0600`. Confirmed against the pre-fix broker, where `/user/emails` comes back `404` — from the upstream, meaning it was forwarded.
- `egress-broker-milestone.mjs`'s Part A4 covers the other half: `CONNECT api.github.com:443` is refused by the egress broker for an app declaring `github:read:repos` *and* `browser:navigate:*`, while every other host under that same `*` still tunnels, and an app declaring no `github:*` still reaches `api.github.com` the coarse way.

- `runBypassScenario()` (original, from the app's promotion to `apps/*`) — the app's own request-shaping logic against a local plain-HTTP mock, independent of the broker.
- `runBrokerScenario()` (new) — the app really dials `https://api.github.com` through the real `ProxyAgent`+broker path; the broker's real outbound leg is redirected (via `BERTH_GITHUB_API_UPSTREAM_HOST`/`_PORT`/`_CA_PATH`, all test-only overrides) to a local mock HTTPS server standing in for GitHub, with its own realistic self-signed cert. Two real assertions:
  - An in-scope `get_repo_summary` call succeeds end-to-end, and the mock upstream genuinely received it.
  - An out-of-scope request (`POST /repos/.../pulls`, driven directly against the broker via a `docker exec`'d raw CONNECT+TLS client, since `apps/github-assistant`'s own exports never call that path) gets a real 403 — and the mock upstream never receives it at all.

## What's deliberately out of scope

- **Multi-app containers.** The broker is only wired into `entrypoint.sh`'s single-app path. A `github:*`-declaring companion app in a `--apps` multi-app sandbox won't get this broker started for it — a real, named gap, not silently unsupported.
- **A general path/verb grammar for arbitrary third-party APIs.** Only `github:*` gets this treatment, and its route table covers the resources an app in this repo actually reaches rather than the whole REST API — everything else is denied, so the gap costs a 403, not a grant. Extending this to other API namespaces would need a materially more general design.
- **Registry/CA distribution for a real (non-test) upstream override.** The `BERTH_GITHUB_API_UPSTREAM_*` env vars exist purely for this milestone test's local mock; there's no supported way to point this broker at anything other than the real `api.github.com` in a real deployment.
