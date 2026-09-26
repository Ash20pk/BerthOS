import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "./types.js";

/** Spawns a local MCP server as a child process — the same shape `berth mcp` itself is driven with in packages/docker-orchestrator/test/mcp-milestone.mjs. */
export interface McpStdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Connects to a remote MCP server over the Streamable HTTP transport (POST + SSE) — most third-party/SaaS MCP servers speak this, not stdio. */
export interface McpHttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
}

/** A pre-built transport (e.g. the SDK's own `InMemoryTransport`, or any custom `Transport` implementation) — for anything the two named shapes above don't cover. */
export type McpTransportOptions = McpStdioTransportOptions | McpHttpTransportOptions | Transport;

export interface McpClientToolsOptions {
  /** Reported to the server as this client's own identity — cosmetic, some servers log/display it. */
  name?: string;
  version?: string;
  transport: McpTransportOptions;
}

/**
 * The other half of `berth mcp` (which makes a Berth resident app's exports
 * available to any MCP client — Claude Desktop, Claude Code, ...): this lets
 * a Berth `Agent` be the *client*, consuming any external MCP server's tools
 * as ordinary `Tool`s. This is intentionally the highest-leverage way to
 * close "only ~7 first-party tool integrations" — the whole MCP tool
 * ecosystem becomes reachable without writing a single bespoke connector.
 */
export interface McpClientHandle {
  /**
   * This server's name, as `createAgent()` announces its tools to a
   * governance app: `mcp:<name>`. Defaults to "mcp" when the caller didn't
   * name it — several unnamed servers therefore share one identity, which is
   * a reason to name them when a governor needs to tell them apart.
   */
  readonly name: string;
  readonly tools: Tool[];
  close(): Promise<void>;
}

function buildTransport(options: McpTransportOptions): Transport {
  if ("command" in options) {
    return new StdioClientTransport({ command: options.command, args: options.args, env: options.env });
  }
  if ("url" in options) {
    return new StreamableHTTPClientTransport(
      new URL(options.url),
      options.headers ? { requestInit: { headers: options.headers } } : undefined,
    );
  }
  // Already a Transport (e.g. InMemoryTransport, or a custom implementation).
  return options;
}

interface McpContentBlock {
  type: string;
  text?: string;
}

interface McpCallToolResult {
  content?: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * MCP tool results carry a `content` block array (text/image/audio/resource)
 * plus an optional `structuredContent` — prefer the latter when a server
 * provides it (it's already the shape the tool's own output schema
 * describes), otherwise collapse an all-text content array into a plain
 * string (the common case — most MCP tools return text), otherwise fall back
 * to the raw content array so non-text results (an image block, say) aren't
 * silently dropped.
 */
function extractResult(result: McpCallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content ?? [];
  if (content.length > 0 && content.every((block) => block.type === "text")) {
    return content.map((block) => block.text).join("\n");
  }
  return content;
}

function extractErrorText(result: McpCallToolResult, toolName: string): string {
  const content = result.content ?? [];
  const text = content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n");
  return text || `MCP tool "${toolName}" reported an error`;
}

/**
 * Connects to an external MCP server and returns its tools as ordinary
 * Berth `Tool`s — mix them into an Agent's tool list alongside resident-app
 * exports and other agents (`Agent.asTool()`) freely, since they all share
 * the same `Tool` interface. No schema translation needed in this
 * direction: MCP's `tools/list` already returns JSON Schema, exactly what
 * `Tool.inputSchema` expects (unlike `berth mcp`'s own server-side code,
 * which has to translate berth.yml's flat IOSpec into a Zod shape first).
 *
 * Call `close()` when done — this owns a live connection (a child process
 * for stdio, an HTTP/SSE session for the streamable transport) that outlives
 * any single tool call, so nothing else can clean it up on your behalf.
 */
export async function createMcpClientTools(options: McpClientToolsOptions): Promise<McpClientHandle> {
  const client = new Client({ name: options.name ?? "berth-agent", version: options.version ?? "0.0.0" });
  const transport = buildTransport(options.transport);
  await client.connect(transport);

  const { tools: mcpTools } = await client.listTools();
  const tools: Tool[] = mcpTools.map((mcpTool) => ({
    name: mcpTool.name,
    description: mcpTool.description ?? "",
    inputSchema: (mcpTool.inputSchema ?? { type: "object", properties: {} }) as object,
    async invoke(input: unknown, ctx): Promise<unknown> {
      // The MCP SDK takes a signal in its per-call options, so a cancelled
      // run really does abandon an in-flight external tool call rather than
      // only stopping the loop that was waiting on it. See REMEDIATION 4.2.
      const result = (await client.callTool(
        {
          name: mcpTool.name,
          arguments: (input ?? {}) as Record<string, unknown>,
        },
        undefined,
        { signal: ctx?.signal },
      )) as McpCallToolResult;
      if (result.isError) {
        throw new Error(extractErrorText(result, mcpTool.name));
      }
      return extractResult(result);
    },
  }));

  return {
    // Carried on the result rather than left in the caller's options, so a
    // consumer that only has the returned object — the governance gate in
    // createAgent(), which announces these tools as `mcp:<name>` — can name
    // the server without reaching back into how it was configured.
    name: options.name ?? "mcp",
    tools,
    close: () => client.close(),
  };
}
