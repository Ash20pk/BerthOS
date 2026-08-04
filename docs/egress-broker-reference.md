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

## Optional: chaining through an upstream proxy (e.g. residential)

Every real navigation `browser-native` makes egresses from wherever this container's own network sits — a cloud VM's or CI runner's datacenter IP range in most deployments. Plenty of real sites (anything behind Cloudflare/PerimeterX-style bot detection, and Google/Bing's own search results specifically) treat that as a signal and block or challenge it, independent of anything `browser:navigate:<pattern>` scoping controls.

Setting **`BERTH_EGRESS_UPSTREAM_PROXY`** on the container (a plain proxy URL, credentials optional — `http://user:pass@residential-proxy.example.com:8000`) makes the broker hop every *allowed* CONNECT through that proxy instead of connecting to the target directly, standard proxy-chaining (the broker issues its own `CONNECT host:port` to the upstream proxy, with a `Proxy-Authorization: Basic ...` header when credentials are present, then splices the two tunnels together once the upstream confirms). The target site sees the upstream proxy's IP, not the container's — this is what actually lets `browser-native` present as a normal residential visitor to a site that would otherwise block it.

Two things that don't change: the host-allow check (`isHostAllowed`) still runs **first**, exactly as without an upstream proxy — a host outside every declared `browser:navigate:<pattern>` is refused before the upstream proxy is ever contacted, so a denied navigation never costs that proxy's bandwidth or quota either. And credentials are never written to any log — only `host:port` (never the URL's `user:pass@` portion) appears in the broker's own stderr lines, including the new `"viaUpstreamProxy": true/false` field on every `navigate_allowed`/`navigate_denied` log line.

This works with any provider that speaks plain HTTP CONNECT + optional `Proxy-Authorization: Basic` — Bright Data, Oxylabs, Smartproxy, and similar all expose exactly that interface, so nothing provider-specific lives in `egress-broker.cjs`. Worth being deliberate about before reaching for this: residential proxy networks are legally and ethically murkier than datacenter ones (many are peer-bandwidth-sharing SDKs with thin end-user consent), and routing traffic through one specifically to defeat a site's bot detection can itself violate that site's terms of service — this repo doesn't take a position on any specific provider or use case, only on making the plumbing correct once you've decided you need it.

## Verification

`packages/docker-orchestrator/test/egress-broker-milestone.mjs`, wired into CI via `.github/workflows/egress-broker-milestone.yml`:

- **Part A** runs the broker directly (no Docker) against a hand-written capability policy declaring a narrow pattern, and proves both a real allowed CONNECT (200) and a real refused one (403) — `browser-native`'s own shipped manifest declares `browser:navigate:*` (any host, since navigating anywhere is its whole point), so a denial can't be demonstrated against the real app; this is what actually exercises the refusal path.
- **Part A2** covers `BERTH_EGRESS_UPSTREAM_PROXY` chaining against a real (if fake, hand-rolled for the test) second CONNECT proxy — no Docker needed, same shape as Part A. Asserts an allowed CONNECT genuinely reaches that second proxy with the expected target and `Proxy-Authorization` header (not silently ignored), and that a denied host never reaches it at all, proving the enforcement-before-chaining ordering described above.
- **Part B** boots the real `browser-native` sandbox and drives an actual headless Chromium navigation through it, confirming the wiring end-to-end: the broker's own allow-log line for the real target host is asserted, proving Chromium's traffic is actually flowing through the broker rather than around it.
