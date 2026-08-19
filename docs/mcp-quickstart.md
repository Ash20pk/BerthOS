# Berth as an MCP server (start here)

The shortest path into Berth: point the agent you already use — Claude Code, Claude Desktop, Cursor, anything that speaks [MCP](https://modelcontextprotocol.io) — at a sandboxed computer whose permissions the kernel enforces. No framework to adopt, no SDK call, no `Agent` class. One command in one config file.

What you get: your agent gains the tools a resident app declares in its `berth.yml`, and nothing else. When it tries something the manifest didn't declare, the call comes back as a denial that names the line which would have allowed it — see [What a denial looks like](#what-a-denial-looks-like), which is the part worth reading even if you never run this.

For the mechanics of the bridge (how manifest exports become MCP tools, what's deferred), see [mcp-bridge-reference.md](./mcp-bridge-reference.md).

## Prerequisites

- Node.js 22+, Docker running locally, `corepack enable`.
- A checkout, built once — `@berth/*` isn't on npm yet:

```bash
git clone https://github.com/Ash20pk/BerthOS && cd BerthOS
corepack enable && pnpm install && pnpm build
```

- **Warm the app's image once**, before you wire up any client. The first `berth mcp` builds a container image, which takes minutes; MCP clients give a server ~60 seconds to answer `initialize` and will kill it mid-build. This is the one step that turns a 5-minute setup into a confusing failure if you skip it:

```bash
node packages/cli/bin/berth.js mcp --app filesystem --app-dir apps/filesystem --warm
```

`--warm` does everything the bridge does except serve MCP: builds the image, boots the sandbox, waits for the app to report ready, stops it again, exits 0. Run it a second time and it should finish in a few seconds — that's your signal the image is cached and a client will get through `initialize` in time.

## Add it to Claude Code

```bash
claude mcp add berth-filesystem -- node /absolute/path/to/BerthOS/packages/cli/bin/berth.js \
  mcp --app filesystem --app-dir /absolute/path/to/BerthOS/apps/filesystem
```

Absolute paths matter: the client spawns this command with its own working directory, not yours.

Then ask Claude Code to write a file with the `write_file` tool, and to write one to `/etc`. The first succeeds inside the sandbox; the second comes back as the denial below.

**On a Colima host** (the [macOS setup where enforcement is real](./mac-enforcement.md)), add `DOCKER_HOST` to the server's environment as well — Berth reaches Docker through dockerode, which reads `DOCKER_HOST` and ignores Docker CLI contexts, so without it the bridge talks to Docker Desktop while your terminal talks to Colima:

```bash
claude mcp add berth-filesystem \
  --env DOCKER_HOST=unix:///Users/<you>/.colima/default/docker.sock \
  -- node /absolute/path/to/BerthOS/packages/cli/bin/berth.js \
  mcp --app filesystem --app-dir /absolute/path/to/BerthOS/apps/filesystem
```

## Add it to Claude Desktop, Cursor, or any JSON-configured client

```json
{
  "mcpServers": {
    "berth-filesystem": {
      "command": "node",
      "args": [
        "/absolute/path/to/BerthOS/packages/cli/bin/berth.js",
        "mcp",
        "--app", "filesystem",
        "--app-dir", "/absolute/path/to/BerthOS/apps/filesystem"
      ],
      "env": { "DOCKER_HOST": "unix:///Users/<you>/.colima/default/docker.sock" }
    }
  }
}
```

Drop the `env` block if you're on plain Docker Desktop or Linux.

## Give it less than everything

`--only` bridges a subset of the app's exports instead of all of them:

```
mcp --app filesystem --app-dir .../apps/filesystem --only write_file,read_file
```

A name that isn't in the manifest is an error, not a silent omission. What `--only` does *not* do is authenticate the caller — see [the bridge reference's deferred list](./mcp-bridge-reference.md#whats-real-vs-deliberately-deferred).

## What a denial looks like

The point of the whole exercise. `apps/filesystem` declares `filesystem:write:/workspace` and `filesystem:write:/context`, so a `write_file` call aimed at `/etc` comes back as:

```
BERTH CAPABILITY DENIAL
app: filesystem
manifest: /path/to/BerthOS/apps/filesystem/berth.yml
raw: EACCES: permission denied, open '/etc/berth-should-not-exist.txt'
denied: open(2) on /etc/berth-should-not-exist.txt (EACCES: permission denied)
denied-by: the kernel — a Landlock ruleset compiled from "filesystem"'s berth.yml and applied before the app's first line ran
fix: none available — a berth.yml filesystem scope may only name /workspace, /context, /tmp, /app, so no declaration grants /etc/berth-should-not-exist.txt. Use a path under one of those instead.
declared: filesystem:read:/workspace, filesystem:write:/workspace, filesystem:read:/context, filesystem:write:/context
docs: docs/capability-tokens-reference.md, docs/manifest-reference.md
```

Three things that message is doing deliberately, because its reader is usually another agent:

- **`fix:` is a real fix or an honest "none available".** `/etc` is outside the four path prefixes a `filesystem:` scope may name at all ([manifest reference](./manifest-reference.md)), so no manifest edit grants it — and printing `filesystem:write:/etc` would be a suggestion the schema rejects. For a denial the manifest *could* grant, the same message names the line and where it goes:

  ```
  fix: add this line to `capabilities:` in .../berth.yml, then restart the app — a Landlock ruleset cannot be
       widened on a running process, so the change takes effect on the next boot, never live:
    - filesystem:write:/workspace/.berth/dev-workspace/boundary-app-b
  ```

- **`denied-by:` never overstates.** It says `the kernel` only when this container's `agent-init` reported a fully enforced Landlock ruleset. On a host without Landlock — Docker Desktop for Mac, for one — the same denial says so plainly and tells you not to read it as enforcement. `unknown` means the bridge couldn't read the container's own statement and won't guess. Run [`berth doctor`](./doctor-reference.md) for the host-level answer.

- **It distinguishes non-capability failures.** An `EROFS` is the read-only workspace mount, not a policy decision, and it says so instead of sending you to edit `capabilities:`. Ordinary application errors and schema-validation failures pass through untouched.

## `berth dev` and `berth mcp` together

`berth mcp` boots the app's sandbox itself when none is running, and stops it again when the bridge exits — on a signal, or when its client closes the pipe. If you're already running `berth dev` for the same app, the bridge attaches to that container instead and leaves it alone — that's the better loop while you're editing the app, since `berth dev` hot-reloads on save and prints the container's logs. `--no-boot` makes "attach only" explicit: it fails rather than booting anything.

Container naming: `berth-dev-<app>` by default, `--container` to override. That's the only coordination between the two commands.

## What isn't covered

- One bridge process serves one app's exports. No merging several apps into one MCP server, and no reaching a companion app inside a multi-app container.
- Local Docker only — not an E2B/Daytona/Kubernetes-hosted instance.
- Stdio only, request/response only: no streaming or long-running tool calls.
- No caller authentication. Anyone who can spawn this command against a running container gets whatever that invocation was scoped to.

Full list, with reasons: [mcp-bridge-reference.md](./mcp-bridge-reference.md#whats-real-vs-deliberately-deferred).

## Verified

`packages/docker-orchestrator/test/mcp-milestone.mjs` drives all of the above with the real `@modelcontextprotocol/sdk` client against real containers: tools/list, a tool call whose write is confirmed by reading the file out of the container directly, the `/etc` denial above, `berth mcp` booting its own sandbox from nothing, and a grantable denial naming the exact `berth.yml` line. It runs in CI on `ubuntu-latest` (`.github/workflows/mcp-milestone.yml`), where Landlock is active, and was last run by hand on a Colima host reporting `enforcement: ACTIVE`.

The network branch of the denial explainer (`network:connect:<port>`) is unit-tested only (`packages/cli/src/util/capability-errors.test.ts`) — no milestone run drives a network denial through the bridge yet.
