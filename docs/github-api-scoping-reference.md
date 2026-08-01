# GitHub API Verb/Path Scoping Reference

`packages/docker-orchestrator/docker/github-api-broker.cjs` enforces the distinction between `github:read:<scope>` and `github:write:<scope>` capabilities (e.g. `github:read:repos` vs `github:write:issues`) — the gap `docs/egress-broker-reference.md` and `docs/capability-tokens-reference.md` both named as needing real TLS interception, unlike `browser:navigate:<pattern>`'s host-level-only enforcement.

## Why this needed a genuinely different broker, not an extension of the egress broker

`egress-broker.cjs` enforces host-level scoping with zero TLS interception because a `CONNECT host:port` line is cleartext by protocol design — the proxy only ever needs to see where to open a raw socket, never anything inside the encrypted session. Distinguishing `GET /repos/x/y` from `POST /repos/x/y/issues` requires the actual HTTP method and path, which live inside the TLS-encrypted application data on any real request to `api.github.com` — invisible to a transparent relay.

`github-api-broker.cjs` is a real, if narrowly-scoped, MITM proxy:

1. **Generates its own CA and a leaf certificate for `api.github.com`** at container boot, using the `openssl` CLI (added to `base.Dockerfile`'s apk packages — Node core has no certificate-signing API of its own).
2. **Terminates the TLS connection itself** when it sees a `CONNECT api.github.com:443` — wrapping the raw socket in `tls.TLSSocket({isServer: true, cert, key})` using that leaf cert, so the app's own TLS client (which must trust this CA — see below) completes a real handshake with the broker, believing it's talking to the real GitHub API.
3. **Feeds the decrypted socket into a real `http.Server`** (via `httpServer.emit("connection", tlsSocket)` rather than `.listen()`) to get genuine HTTP request parsing off it, no hand-rolled parser.
4. **Checks the real method + path** against declared `github:read:*`/`github:write:*` capabilities — GET/HEAD map to `read`, everything else to `write`; the requested "scope" is the first path segment after `/repos/<owner>/<repo>/` (or `repos` itself for a bare repo-summary request). This is a v0 heuristic tuned to `apps/github-assistant`'s own two exports, not a general REST-API-aware grammar.
5. **On denial**: responds 403 immediately — the real GitHub API is never contacted.
6. **On allow**: opens a brand-new, real outbound TLS connection to the real `api.github.com` and forwards the request, streaming the real response back. This is a genuine decrypt → decide → re-encrypt round trip.

## How an app actually routes through it

Unlike `browser-native`'s Chromium (which gets an explicit `proxy: {server: ...}` Playwright launch option), `apps/github-assistant` is a plain Node app calling `fetch()` — and Node's built-in fetch (undici) does **not** consult `HTTPS_PROXY`/etc on its own. So:

- `apps/github-assistant` adds a real `undici` dependency and calls `setGlobalDispatcher(new ProxyAgent(process.env.BERTH_GITHUB_API_PROXY))` at module load, when that env var is set (`src/index.ts`).
- `entrypoint.sh`'s single-app path (only — see "What's deliberately out of scope" below) starts the broker whenever `berth.yml` declares any `github:*` capability, waits for its generated CA to appear, then exports `BERTH_GITHUB_API_PROXY=http://127.0.0.1:8092` and `NODE_EXTRA_CA_CERTS=<broker's ca.crt>` before handing off to `agent-init` — the app process inherits both.
- `NODE_EXTRA_CA_CERTS` needs no application code at all — Node's TLS stack reads it automatically at process start, which is what makes the app's `ProxyAgent`-routed TLS handshake with the broker (impersonating `api.github.com`) actually succeed.
- `apps/github-assistant/berth.yml`'s `network:connect:443` was narrowed to `network:connect:8092` (the broker's own local port) — same pattern `apps/browser-native` uses for the egress broker: the kernel only needs to permit reaching the local broker; the broker does the real enforcement.

One real interaction this surfaced: the broker auto-starts whenever `github:*` is declared, but `github-assistant-milestone.mjs`'s original (pre-broker) test bypasses everything via `GITHUB_API_BASE_URL` pointed at a plain-HTTP mock — which the broker's CONNECT-only listener would otherwise 400. `src/index.ts` only calls `setGlobalDispatcher` when `GITHUB_API_BASE_URL` is *not* set, keeping that original test broker-free rather than special-casing plain HTTP inside the broker itself.

## Verification

`packages/docker-orchestrator/test/github-assistant-milestone.mjs` now runs two scenarios:

- `runBypassScenario()` (original, from the app's promotion to `apps/*`) — the app's own request-shaping logic against a local plain-HTTP mock, independent of the broker.
- `runBrokerScenario()` (new) — the app really dials `https://api.github.com` through the real `ProxyAgent`+broker path; the broker's real outbound leg is redirected (via `BERTH_GITHUB_API_UPSTREAM_HOST`/`_PORT`/`_CA_PATH`, all test-only overrides) to a local mock HTTPS server standing in for GitHub, with its own realistic self-signed cert. Two real assertions:
  - An in-scope `get_repo_summary` call succeeds end-to-end, and the mock upstream genuinely received it.
  - An out-of-scope request (`POST /repos/.../pulls`, driven directly against the broker via a `docker exec`'d raw CONNECT+TLS client, since `apps/github-assistant`'s own exports never call that path) gets a real 403 — and the mock upstream never receives it at all.

## What's deliberately out of scope

- **Multi-app containers.** The broker is only wired into `entrypoint.sh`'s single-app path. A `github:*`-declaring companion app in a `--apps` multi-app sandbox won't get this broker started for it — a real, named gap, not silently unsupported.
- **A general path/verb grammar for arbitrary third-party APIs.** Only `github:*` gets this treatment, with a GitHub-specific path heuristic (`/repos/<owner>/<repo>/<scope>`). Extending this to other API namespaces would need a materially more general design.
- **Registry/CA distribution for a real (non-test) upstream override.** The `BERTH_GITHUB_API_UPSTREAM_*` env vars exist purely for this milestone test's local mock; there's no supported way to point this broker at anything other than the real `api.github.com` in a real deployment.
