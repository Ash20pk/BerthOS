# Berth as an MCP server (start here)

Point the agent you already use (Claude Code, Claude Desktop, Cursor, or any [MCP](https://modelcontextprotocol.io) client) at a sandboxed tool whose permissions the kernel enforces. No framework and no code: one entry in your client's config.

Your agent gets the tools a resident app declares in its `berth.yml`, and nothing else. When it tries something the manifest doesn't allow, the call comes back as a denial that names the line that would allow it. See [What a denial looks like](#what-a-denial-looks-like).

How the bridge works, and its flags: [mcp-bridge-reference.md](./mcp-bridge-reference.md).

## Prerequisites

- Node.js 22+, Docker running locally, `corepack enable`.
- A built checkout of the repository, which holds the apps:

```bash
git clone https://github.com/Ash20pk/BerthOS && cd BerthOS
corepack enable && pnpm install && pnpm build
```

- **Warm the app's image once**, before you configure a client. The first `berth mcp` builds a container image, which takes minutes. MCP clients give a server about 60 seconds to answer `initialize` and kill it if it's still building. Skip this and the setup fails in a confusing way.

```bash
node packages/cli/bin/berth.js mcp --app filesystem --app-dir apps/filesystem --warm
```

`--warm` builds the image, boots the sandbox, waits for the app to report ready, stops it, and exits 0. Run it a second time: it should finish in a few seconds, which means the image is cached and a client will get through `initialize` in time.

Enforcement needs a Landlock kernel. On macOS or Windows, run `node packages/cli/bin/berth.js doctor` first; see [the doctor reference](./doctor-reference.md).

## Add it to Claude Code

```bash
claude mcp add berth-filesystem -- node /absolute/path/to/BerthOS/packages/cli/bin/berth.js \
  mcp --app filesystem --app-dir /absolute/path/to/BerthOS/apps/filesystem
```

Use absolute paths: the client runs this command from its own working directory, not yours.

Then ask Claude Code to write a file with the `write_file` tool, and then to write one to `/etc`. The first succeeds inside the sandbox. The second comes back as the denial below.

**On a Colima host** (the [macOS setup that enforces](./mac-enforcement.md)), the bridge follows your current Docker context (`docker context use colima`), as your terminal does. To pin it regardless of the context selected when the client starts the server, set `DOCKER_HOST` in the server's environment:

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

Drop the `env` block on Docker Desktop or Linux.

## Give it less than everything

`--only` bridges some of the app's exports instead of all of them:

```
mcp --app filesystem --app-dir .../apps/filesystem --only write_file,read_file
```

A name that isn't in the manifest is an error. `--only` limits what the bridge exposes; it doesn't authenticate the caller ([limits](./mcp-bridge-reference.md#whats-real-vs-deliberately-deferred)).

## What a denial looks like

`apps/filesystem` declares write access to `/workspace` and `/context`, so a `write_file` call aimed at `/etc` comes back as:

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

The reader is usually another agent, so the message is built to be acted on:

- **`fix:`** names the line to add when one exists. `/etc` is outside the four prefixes a `filesystem:` scope may name ([manifest reference](./manifest-reference.md)), so nothing can grant it. For a path the manifest could grant, you get the exact line and where it goes:

  ```
  fix: add this line to `capabilities:` in .../berth.yml, then restart the app — a Landlock ruleset cannot be
       widened on a running process, so the change takes effect on the next boot, never live:
    - filesystem:write:/workspace/.berth/dev-workspace/boundary-app-b
  ```

- **`denied-by:`** says `the kernel` only when the container reported a fully enforced Landlock ruleset. On a host without Landlock, such as Docker Desktop for Mac, it says the denial is not enforcement. `unknown` means the bridge couldn't read the container's enforcement status. Run [`berth doctor`](./doctor-reference.md) for the host-level answer.

- **Other failures stay what they are.** `EROFS` is the read-only workspace mount, and the message says so instead of pointing at `capabilities:`. Ordinary app errors and input validation errors pass through unchanged.

## See what it did, and prove it

Every session is recorded. The bridge prints its run id when it starts:

```
[berth:mcp] recording tool calls in ~/.berth/audit/audit.jsonl as run mcp-filesystem-20260928T101500Z-3fa2c1 — attest it with `berth attest mcp-filesystem-20260928T101500Z-3fa2c1`
```

Afterwards, even once the sandbox has stopped:

```bash
berth audit list --decision denied                     # what the sandbox refused
berth audit verify                                     # the trail hasn't been edited
berth attest mcp-filesystem-20260928T101500Z-3fa2c1 --out session.json
node scripts/verify-attestation.mjs session.json       # anyone can check it, no Berth install
```

The record says which calls the session made, which policies were enforced, and whether the kernel was enforcing them (`ACTIVE`) or not (`NOT_ENFORCED`). Only which export was called, when and with what outcome is recorded, not inputs or outputs. Use `--run-id` to choose the id, `--no-audit` to turn it off. See [audit](./audit-reference.md) and [attestation](./attestation-reference.md).

## `berth dev` and `berth mcp` together

`berth mcp` boots the app's sandbox when none is running and stops it when the bridge exits, on a signal or when the client closes the pipe. If `berth dev` is already running the same app, the bridge attaches to that container and leaves it running. That's the better loop while you edit the app: `berth dev` reloads on save and shows the logs. `--no-boot` makes the bridge attach only, and fail if nothing is running.

Both commands use the container name `berth-dev-<app>`. Pass `--container` to use another.

## Limits

- One bridge serves one app. To give an agent several apps, add one server entry per app.
- Local Docker only, not an E2B, Daytona or Kubernetes instance.
- No caller authentication: anyone who can run this command against a running container gets the exports that invocation exposes.

The full list is in [the bridge reference](./mcp-bridge-reference.md#whats-real-vs-deliberately-deferred).
