# Egress Broker Reference

`browser:navigate:<pattern>` and `github:*` capabilities are declared and parsed like any other, but Landlock has no way to enforce them — they're API/host scopes, not filesystem paths or bare TCP ports. `packages/docker-orchestrator/docker/egress-broker.cjs` closes that gap for `browser:navigate:*`, the one such capability with a real consumer today (`apps/browser-native`).

## Why no TLS interception is needed

A forward proxy's `CONNECT host:port` line names its target in cleartext by protocol design — that's how HTTPS proxying has always worked, tunnel bytes after the CONNECT without ever decrypting them. So enforcing **host-level** scoping (`browser:navigate:*.github.com`) needs no CA generation, no cert injection, no MITM: the broker reads the target host straight off the CONNECT request, checks it against the app's declared `browser:navigate:<pattern>` capabilities (reusing the same glob-match logic as `@berth/manifest-schema`'s `matchesCapability()`, duplicated rather than imported — see the file's own header comment on why), and either tunnels the bytes through unmodified or refuses before any flow.

What this broker can't do: **path/verb-level** API scoping (`github:read:repos` vs `github:write:issues`) needs to see inside the TLS session, which does need real interception. That gap is now closed by a second, genuinely different broker — `github-api-broker.cjs` — which does real MITM (CA generation, a per-host leaf cert for `api.github.com`, decrypt/decide/re-encrypt). See `docs/github-api-scoping-reference.md`.

## How it's wired

- `entrypoint.sh` starts the broker (`node /usr/local/bin/berth-egress-broker.js`, listening on `127.0.0.1:${BERTH_EGRESS_BROKER_PORT:-8090}`) for whichever app declares a `browser:*` capability, right after that app's `capability-policy.json` is generated — same conditional as the existing Xvfb/VNC startup.
- The broker reads that same `capability-policy.json`'s `declaredCapabilities` at startup (no new config file) and filters for `browser:navigate:*` entries.
- `apps/browser-native/src/cdp-controller.ts` launches Chromium with `proxy: { server: "http://127.0.0.1:8090" }` — a Playwright launch option that maps to Chromium's native `--proxy-server` flag, applying browser-wide.
- `apps/browser-native/berth.yml` narrows its Landlock network grant from unrestricted (`network:connect:*`) to just the broker's own port (`network:connect:8090`) — the kernel becomes the backstop forcing traffic through the broker; the broker does the host-matching. **Caveat:** Landlock's network scoping is port-only, not address-scoped, so this technically permits connecting to port 8090 on any host, not just `127.0.0.1` — the real enforcement is the broker's own refusal, not this Landlock rule in isolation.

## Verification

`packages/docker-orchestrator/test/egress-broker-milestone.mjs`, wired into CI via `.github/workflows/egress-broker-milestone.yml`:

- **Part A** runs the broker directly (no Docker) against a hand-written capability policy declaring a narrow pattern, and proves both a real allowed CONNECT (200) and a real refused one (403) — `browser-native`'s own shipped manifest declares `browser:navigate:*` (any host, since navigating anywhere is its whole point), so a denial can't be demonstrated against the real app; this is what actually exercises the refusal path.
- **Part B** boots the real `browser-native` sandbox and drives an actual headless Chromium navigation through it, confirming the wiring end-to-end: the broker's own allow-log line for the real target host is asserted, proving Chromium's traffic is actually flowing through the broker rather than around it.
