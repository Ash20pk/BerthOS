# web-fetch

Lets an agent call APIs and read web pages on the hosts you list, and nowhere else. Every request goes through the sandbox's egress proxy, which refuses any host `berth.yml` doesn't name, so this holds however the agent is prompted.

## Run it

```bash
cd apps/web-fetch
berth dev
berth test
```

`berth` is the CLI: `npm install -g @berthos/cli`, or `node ../../packages/cli/bin/berth.js` from a clone. As MCP tools: `berth mcp --app web-fetch --app-dir apps/web-fetch`.

## Choose the hosts

Edit `capabilities:` in `berth.yml`. It ships with `example.com` only:

```yaml
capabilities:
  - network:host:api.github.com
  - network:host:*.wikipedia.org
  - network:host:api.internal.example:8443
  - network:connect:8090
```

- A host with no port covers 80 and 443. Name any other port, or use `:*`.
- Only `*` is a wildcard, and `*.example.com` doesn't cover `example.com` itself.
- Internal addresses (loopback, private ranges, the cloud metadata address `169.254.169.254`, the Docker host) are refused under every pattern, `*` included.
- Keep `network:connect:8090`: it's the egress proxy's port, and the only one the kernel lets this app connect to.

Restart the app after editing: a sandbox's rules are fixed when it boots. See the [egress proxy reference](../../docs/egress-broker-reference.md).

## API keys

To send credentials, set the `WEB_FETCH_HEADERS` secret to a JSON object mapping a host to headers:

```json
{ "api.example.com": { "Authorization": "Bearer sk-..." } }
```

The app adds those headers to requests to that host only, including after a redirect to it, and never to another host. The agent never sees them. Pass the value when you boot the sandbox: `berth os up --env WEB_FETCH_HEADERS`, or `Computer.boot({ env })` ([secrets](../../docs/secrets-reference.md)). Without it the app warns once at boot and runs without credentials.

## Exports

| Export | Input | Output | What it does |
|---|---|---|---|
| `get` | `{ url }` | `{ url, status, content_type, body, truncated }` | A GET request |
| `request` | `{ method, url, body, content_type }` | same as `get` | Any of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS. Pass `""` for no body |
| `read_page` | `{ url }` | `{ url, status, title, text, links, truncated }` | A web page as readable text: scripts and styling dropped, block structure kept, links made absolute |
| `allowed_hosts` | | `{ hosts }` | The host patterns this app may reach, so an agent can check before asking |

`url` in a result is the final URL, after redirects.

## Behaviour

- **Refusals say what to change.** A host not in `berth.yml` is refused before anything is sent, with the exact line to add. An internal address is refused with an explanation that no line would allow it.
- **Redirects are followed by hand**, up to five, and each hop's host is checked the same way. A redirect to a host you didn't list is refused.
- **Limits:** 30 s per request; at most 5 MB read, and 100,000 characters returned (`truncated` says when either cut in). Non-text responses come back as a one-line description, not bytes.
- **Not a browser:** `read_page` doesn't run JavaScript. For pages that need it, use [`browser-native`](../browser-native).
