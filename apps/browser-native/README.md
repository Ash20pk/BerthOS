# browser-native

A resident app that gives an agent a real, visible Chromium browser — navigate, click, and read page text, watchable live over VNC while it runs.

## Exports

| Export | Input | Output | Does |
|---|---|---|---|
| `navigate` | `{ url: string }` | — | Navigates the current page to `url` |
| `click` | `{ selector: string }` | — | Clicks the first element matching `selector` |
| `get_page_text` | — | `{ text: string }` | Returns `innerText` of `<body>` on the current page |

The browser and page are lazily launched on first use and reused across calls (`src/cdp-controller.ts`).

## Capabilities

```yaml
capabilities:
  - browser:navigate:*
  - browser:screenshot:*
  - network:connect:8090
```

Network is deny-by-default, so this app doesn't get a wide-open `network:connect:*`. Instead Chromium is launched with `--proxy-server` pointed at the egress broker's loopback port (8090), and the broker — not the Landlock rule — is what actually enforces `browser:navigate:<pattern>` host-matching. The Landlock grant just makes it impossible for this app to reach anything on the internet directly; it does not itself scope by host (Landlock's network enforcement is port-only). See [docs/egress-broker-reference.md](../../docs/egress-broker-reference.md) and [docs/capability-tokens-reference.md](../../docs/capability-tokens-reference.md).

## Running it

```bash
cd apps/browser-native
pnpm exec berth dev
```

Because this app declares a `browser:*` capability, `berth dev` prints a noVNC URL and a per-boot VNC password — open it in a tab to watch the sandboxed Chromium instance live as the agent drives it. The port is bound to `127.0.0.1`.

In `BERTH_TEST_MODE=1` (set automatically by `berth test`), Chromium launches headless instead of against Xvfb, so no display is required.

## Notes

- Chromium is the system binary (`CHROME_BIN`), not Playwright's bundled download — the base image already ships `chromium`/`chromium-chromedriver`.
- **There is no CDP listener.** Chromium is driven over `--remote-debugging-pipe`, which Playwright sets up itself, so no debugging port is bound anywhere — not on the host, not on the container's loopback, not reachable by a sibling app. It used to bind `9222` on container loopback; that also made Chromium fail to start under a real Landlock policy, since this app declares no bind capability. An unauthenticated CDP endpoint is arbitrary local-file read and a complete bypass of the egress broker, so removing it is a straight improvement.
