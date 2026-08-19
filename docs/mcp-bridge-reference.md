# MCP Bridge Reference

> **Setting it up?** [mcp-quickstart.md](./mcp-quickstart.md) is the 5-minute path — the client config for Claude Code/Desktop/Cursor, the `--warm` step, and how to read a denial. This page is the mechanics.

`berth mcp --app=<name>` exposes one resident app's declared `berth.yml` exports as [MCP](https://modelcontextprotocol.io) tools, so an MCP client (Claude Desktop, Claude Code, etc.) can call them directly — no new transport, just a protocol translator over the same mechanisms `berth rpc`/`berth logs` already use to reach an app's runtime from the host. This doc covers Berth as an MCP *server*. For the other direction — a Berth `Agent` consuming an *external* MCP server's tools — see `createMcpClientTools()` in [`docs/agents-reference.md`](./agents-reference.md#consuming-an-external-mcp-server-createmcpclienttools) (TypeScript) or `create_mcp_client_tools()` in `docs/agents-python-reference.md` (Python); that's a separate feature in `@berth/agents`/`berth_agents`, not part of this bridge.

## How it's wired

- `berth mcp` **boots the app's sandbox itself** when no container is already running, via `bootDevContainer()` (`packages/cli/src/util/dev-boot.ts`, extracted from `berth dev` so both take the same mount layout and per-app policy volumes), then waits for the app's runtime to report ready before serving. It stops what it booted when the bridge exits — on SIGINT/SIGTERM, or when the client closes stdin. An already-running `berth dev` container is attached to and left alone; `--no-boot` refuses to boot anything. This is what makes the command usable as an MCP client's *only* command: a client spawns one process and has nowhere to put "run `berth dev` first."
- `--warm` runs that boot path and stops, without serving MCP. It exists because the first build takes minutes and an MCP client will kill a server that can't answer `initialize` inside its startup timeout — a failure that reads as "the bridge is broken" rather than "the image wasn't built yet."
- Every human-readable line the command emits goes to **stderr**, because stdout is the MCP transport. `buildImage()`'s progress already went there; the boot and enforcement lines follow it.
- A tool call's error is passed through `explainAppError()` (`packages/cli/src/util/capability-errors.ts`) before it's returned as `isError` content — see [Denials as the API](#denials-as-the-api) below.
- `packages/cli/src/util/mcp-tools.ts` maps each `berth.yml` export's flat `input` map (`IOSpec`, e.g. `{ path: string, content: string }`) to a Zod raw shape — the form `@modelcontextprotocol/sdk`'s `McpServer.registerTool()` expects for `inputSchema`. `IOSpec` has no nesting, so this is a direct one-to-one field mapping (`string`→`z.string()`, `object`→`z.record(...)`, `array`→`z.array(z.unknown())`, etc.) — no schema inference beyond what the manifest already declares.
- `packages/cli/src/commands/mcp.ts` builds an `McpServer`, registers one tool per export, and connects it over `StdioServerTransport` — so `berth mcp --app=<name>` itself becomes a stdio MCP server process an MCP client spawns directly.
- Each tool's handler calls `@berth/docker-orchestrator`'s `createStdioRpcClient()` (new — `packages/docker-orchestrator/src/stdio-rpc.ts`), which speaks the app runtime's line-delimited JSON RPC protocol over `container.attach()`, reusing one connection for every tool call for the lifetime of the `berth mcp` process.

## Why this needed a new RPC client, not `berth rpc`'s existing one

`berth rpc`/`invokeAppExport()` (`packages/docker-orchestrator/src/relay.ts`) reaches an app via `docker exec` + a per-app Unix socket at `/run/berth/<app>/rpc.sock` — but that socket is **only created in multi-app mode** (`entrypoint.sh`'s `BERTH_APPS`-driven branch). A plain single-app `berth dev` container (the common case, and this bridge's actual target) execs straight into the app's own runtime as PID 1, with no such socket — the app is only reachable over the container's own stdio, exactly how `capability-enforcement.mjs`'s and `grants-server-milestone.mjs`'s test-only RPC clients already work. `createStdioRpcClient()` is that same pattern, productionized as a reusable export instead of copy-pasted per test file.

## Denials as the API

The reader on the other end of this transport is usually another agent, and `EACCES: permission denied, open '/etc/x'` says nothing about `berth.yml`. So a denied call comes back as a labelled block: what was denied (`syscall(2)` and path), what denied it, the capability line that would allow it, where that line goes, and the app's current declarations. `docs/mcp-quickstart.md` shows the full output.

Four rules it follows, each one a thing it would be easy to get wrong:

- **A fix line is only offered when a fix exists.** A `filesystem:` scope may only name `/workspace`, `/context`, `/tmp`, `/app`, so a denial at `/etc` gets `fix: none available` plus the list — not `filesystem:write:/etc`, which the schema rejects. Where the path *is* grantable, the exact line is printed along with the restart requirement (a Landlock ruleset cannot be widened on a running process).
- **`denied-by:` follows `agent-init`'s own report, not an assumption.** The bridge reads the container's boot line (`enforcementFromContainerLogs()`), so it claims `the kernel` only on a fully enforced ruleset; a `NotEnforced` container gets told explicitly that this denial is *not* the Landlock policy and must not be read as enforcement, and an unreadable log gets `unknown` rather than a guess. This is the per-container counterpart of `berth doctor`'s per-host verdict.
- **Non-capability failures are not dressed up as capability failures.** `EROFS` is the read-only workspace mount and says so; an already-declared path that still fails points at file ownership rather than at another manifest line; `ENOENT`, Zod validation errors, and ordinary app exceptions pass through untouched.
- **An ambiguous syscall stays ambiguous.** `open(2)` is used for both reading and writing, so both lines are offered with a note to declare the one the export actually needs, rather than a confident guess.

Verified end to end in `packages/docker-orchestrator/test/mcp-milestone.mjs` (Tests 3 and 5: the `/etc` case against `apps/filesystem`, and a grantable cross-app denial against `test/fixtures/boundary-app-a` that must name `filesystem:write:/workspace/.berth/dev-workspace/boundary-app-b`). Branch coverage for the message shapes, including the not-enforced and network cases, is in `packages/cli/src/util/capability-errors.test.ts`. The network branch has no milestone run of its own yet.

## What's real vs. deliberately deferred

**Real:** a running local `berth dev` container's exports are genuinely reachable as MCP tools from any real MCP client — verified end-to-end in `packages/docker-orchestrator/test/mcp-milestone.mjs` using the actual `@modelcontextprotocol/sdk` `Client`/`StdioClientTransport` on the test side too (not a mock of the MCP protocol on either end).

**Real, as of gap #26's closure (2026-08-06):** `--only=<export1>,<export2>` (comma-separated) scopes which exports get bridged at all, instead of blanket "everything this app declares." `packages/cli/src/util/mcp-tools.ts`'s `parseOnlyExports()` validates every named export actually exists in the manifest, erroring loudly on a typo rather than silently bridging fewer tools than intended — the same least-privilege shape `applyHumanApprovalGate()`'s own `only` option already has for Agent tool calls (see `docs/agents-reference.md`).

**Real, as of launch-plan 1.5 (2026-08-19):** self-booting (`--no-boot` opts out), `--warm`, and the explained denials above.

**Still deferred:**
- **Cryptographic auth.** `--only` narrows *what* a spawned bridge can reach; it doesn't add a token verifying *who* is calling. Anyone who can spawn `berth mcp --app=<name>` against a running container can still use whatever `--only` (or the full export list, by default) that invocation was given — naming this precisely rather than overclaiming what `--only` fixes.
- **Remote/fleet-hosted apps.** Only a local `berth dev` container is supported — no E2B/Daytona/K8s-backed instance.
- **Companion apps in a multi-app container.** This bridge only reaches the container's primary app (PID 1's stdio). A companion app in a `--apps` multi-app sandbox has its own Unix socket (like `berth rpc` targets) but isn't wired into this bridge.
- **Multi-app aggregation.** One `berth mcp` process is one app's tools — no merging several apps' exports into a single MCP server.
- **Non-stdio transports and streaming.** Stdio only; the underlying RPC protocol is request/response, so no long-running or streaming tool calls.
