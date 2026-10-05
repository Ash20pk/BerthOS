# browser-native

Gives an agent a real Chromium browser that you can watch live over VNC while it works. The agent can search, navigate, click, fill in forms and read page text, and every request goes through a proxy that checks the hostname against the app's `browser:navigate:*` capabilities.

## Run it

```bash
cd apps/browser-native
berth dev
berth test
```

`berth` is the CLI: `npm install -g @berthos/cli`, or `node ../../packages/cli/bin/berth.js` from a clone. Because the app declares a `browser:*` capability, `berth dev` prints a noVNC URL and a password:

```
[berth:dev] noVNC:    http://127.0.0.1:<port>/vnc.html
[berth:dev] VNC:      127.0.0.1:<port>
[berth:dev]           password: <generated per boot>
```

Open the noVNC URL to watch the agent drive the browser. The ports listen on `127.0.0.1` only and the password changes on every boot. Under `berth test` (which sets `BERTH_TEST_MODE=1`), Chromium runs headless and needs no display.

To keep the capability but stop `berth dev` publishing the VNC ports (for example in CI), set `expose: { browser: false }` in `berth.yml`; see the [manifest reference](../../docs/manifest-reference.md).

## Capabilities

```yaml
capabilities:
  - browser:navigate:*
  - browser:screenshot:*
  - network:connect:8090
```

Chromium's only route out is the egress proxy on port 8090, and the kernel refuses connections on any other port. The proxy, not the kernel, decides which hostnames are reachable, by matching them against `browser:navigate:<pattern>`: the kernel sees ports, not hostnames. Narrow `browser:navigate:*` to the sites your agent needs, such as `browser:navigate:*.example.com`. See the [egress proxy reference](../../docs/egress-broker-reference.md).

## Exports

| Export | Input | Output | What it does |
|---|---|---|---|
| `navigate` | `{ url }` | | Opens `url` in the current page |
| `click` | `{ selector }` | | Clicks the element matching `selector` (a Playwright selector, such as CSS) |
| `fill` | `{ selector, value }` | | Clears the input, textarea or contenteditable element matching `selector` and types `value` into it |
| `press` | `{ selector, key }` | | Focuses the element matching `selector` and presses `key` (a Playwright key name, such as `Enter` or `Tab`) |
| `get_page_text` | | `{ text }` | Returns the visible text of the page's `<body>` |
| `search` | `{ query, maxResults? }` | `{ results: { title, url, snippet }[] }` | Searches DuckDuckGo and returns the top results (5 by default) |

The browser starts on the first call and is reused after that. `search` loads `duckduckgo.com`, so it only works when your `browser:navigate:*` patterns allow that host.

## How it works

- Chromium is the system binary from the base image (`CHROME_BIN`), not Playwright's bundled download.
- Playwright drives it over a pipe (`--remote-debugging-pipe`), so no DevTools port is open anywhere, including to other apps in the sandbox.

## Limits

- One sandbox can hold only one app with a `browser:*` capability.
