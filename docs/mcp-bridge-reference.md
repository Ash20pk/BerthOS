# MCP Bridge Reference

`berth mcp --app=<name>` exposes one resident app's declared `berth.yml` exports as [MCP](https://modelcontextprotocol.io) tools, so an MCP client (Claude Desktop, Claude Code, etc.) can call them directly — no new transport, just a protocol translator over the same mechanisms `berth rpc`/`berth logs` already use to reach an app's runtime from the host. This doc covers Berth as an MCP *server*. For the other direction — a Berth `Agent` consuming an *external* MCP server's tools — see `createMcpClientTools()` in [`docs/agents-reference.md`](./agents-reference.md#consuming-an-external-mcp-server-createmcpclienttools) (TypeScript) or `create_mcp_client_tools()` in `docs/agents-python-reference.md` (Python); that's a separate feature in `@berth/agents`/`berth_agents`, not part of this bridge.

## How it's wired

- `packages/cli/src/util/mcp-tools.ts` maps each `berth.yml` export's flat `input` map (`IOSpec`, e.g. `{ path: string, content: string }`) to a Zod raw shape — the form `@modelcontextprotocol/sdk`'s `McpServer.registerTool()` expects for `inputSchema`. `IOSpec` has no nesting, so this is a direct one-to-one field mapping (`string`→`z.string()`, `object`→`z.record(...)`, `array`→`z.array(z.unknown())`, etc.) — no schema inference beyond what the manifest already declares.
- `packages/cli/src/commands/mcp.ts` builds an `McpServer`, registers one tool per export, and connects it over `StdioServerTransport` — so `berth mcp --app=<name>` itself becomes a stdio MCP server process an MCP client spawns directly.
- Each tool's handler calls `@berth/docker-orchestrator`'s `createStdioRpcClient()` (new — `packages/docker-orchestrator/src/stdio-rpc.ts`), which speaks the app runtime's line-delimited JSON RPC protocol over `container.attach()`, reusing one connection for every tool call for the lifetime of the `berth mcp` process.

## Why this needed a new RPC client, not `berth rpc`'s existing one

`berth rpc`/`invokeAppExport()` (`packages/docker-orchestrator/src/relay.ts`) reaches an app via `docker exec` + a per-app Unix socket at `/tmp/berth-rpc/<app>.sock` — but that socket is **only created in multi-app mode** (`entrypoint.sh`'s `BERTH_APPS`-driven branch). A plain single-app `berth dev` container (the common case, and this bridge's actual target) execs straight into the app's own runtime as PID 1, with no such socket — the app is only reachable over the container's own stdio, exactly how `capability-enforcement.mjs`'s and `grants-server-milestone.mjs`'s test-only RPC clients already work. `createStdioRpcClient()` is that same pattern, productionized as a reusable export instead of copy-pasted per test file.

## What's real vs. deliberately deferred

**Real:** a running local `berth dev` container's exports are genuinely reachable as MCP tools from any real MCP client — verified end-to-end in `packages/docker-orchestrator/test/mcp-milestone.mjs` using the actual `@modelcontextprotocol/sdk` `Client`/`StdioClientTransport` on the test side too (not a mock of the MCP protocol on either end).

**Real, as of gap #26's closure (2026-08-06):** `--only=<export1>,<export2>` (comma-separated) scopes which exports get bridged at all, instead of blanket "everything this app declares." `packages/cli/src/util/mcp-tools.ts`'s `parseOnlyExports()` validates every named export actually exists in the manifest, erroring loudly on a typo rather than silently bridging fewer tools than intended — the same least-privilege shape `applyHumanApprovalGate()`'s own `only` option already has for Agent tool calls (see `docs/agents-reference.md`).

**Still deferred:**
- **Cryptographic auth.** `--only` narrows *what* a spawned bridge can reach; it doesn't add a token verifying *who* is calling. Anyone who can spawn `berth mcp --app=<name>` against a running container can still use whatever `--only` (or the full export list, by default) that invocation was given — naming this precisely rather than overclaiming what `--only` fixes.
- **Remote/fleet-hosted apps.** Only a local `berth dev` container is supported — no E2B/Daytona/K8s-backed instance.
- **Companion apps in a multi-app container.** This bridge only reaches the container's primary app (PID 1's stdio). A companion app in a `--apps` multi-app sandbox has its own Unix socket (like `berth rpc` targets) but isn't wired into this bridge.
- **Multi-app aggregation.** One `berth mcp` process is one app's tools — no merging several apps' exports into a single MCP server.
- **Non-stdio transports and streaming.** Stdio only; the underlying RPC protocol is request/response, so no long-running or streaming tool calls.
