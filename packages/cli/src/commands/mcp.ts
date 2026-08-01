import { Command, Flags } from "@oclif/core";
import Docker from "dockerode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadManifest } from "@berth/manifest-schema";
import { createStdioRpcClient } from "@berth/docker-orchestrator";
import { mcpToolsFor } from "../util/mcp-tools.js";

/**
 * Bridges one resident app's already-declared exports to MCP tools, so an
 * MCP client (Claude Desktop, Claude Code, etc.) can call them directly.
 * Targets a single-app `berth dev` container, where the app's runtime is
 * PID 1 and reachable directly over the container's own stdio
 * (createStdioRpcClient) — not `berth rpc`'s invokeAppExport, which relays
 * to a per-app Unix socket that only exists in multi-app-per-sandbox mode.
 *
 * Deliberately out of scope for this MVP (see docs/mcp-bridge-reference.md):
 * auth (MCP calls bypass capability tokens entirely, same as `berth rpc`
 * today), remote/fleet-hosted apps, reaching a companion app inside a
 * multi-app container, and non-stdio transports.
 */
export default class Mcp extends Command {
  static override description =
    "Expose a resident app's declared exports as MCP tools over stdio, for MCP clients (Claude Desktop, Claude Code, etc.) to call directly";
  static override flags = {
    app: Flags.string({ required: true, description: "the app's name (as declared in its berth.yml)" }),
    container: Flags.string({ description: "container name to reach (defaults to berth-dev-<app>)" }),
    "app-dir": Flags.string({ description: "path to the app's directory (defaults to the current directory)", default: "." }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Mcp);
    const appName = flags.app;
    const containerName = flags.container ?? `berth-dev-${appName}`;

    const manifest = await loadManifest(`${flags["app-dir"]}/berth.yml`).catch((err: unknown) => {
      this.error(`couldn't load berth.yml from "${flags["app-dir"]}": ${err instanceof Error ? err.message : String(err)}`);
    });
    if (manifest.name !== appName) {
      this.warn(`--app=${appName} doesn't match berth.yml's declared name "${manifest.name}" — proceeding with --app's value for the RPC target`);
    }

    const docker = new Docker();
    const container = docker.getContainer(containerName);
    try {
      await container.inspect();
    } catch {
      this.error(
        `no running container named "${containerName}" — is "berth dev" running for this app? (pass --container if it's under a different name)`,
      );
    }

    const rpc = await createStdioRpcClient(container, docker);

    const server = new McpServer({ name: `berth-${appName}`, version: manifest.version });

    for (const tool of mcpToolsFor(manifest)) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.inputShape },
        async (args: Record<string, unknown>) => {
          const response = await rpc.call({
            id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            export: tool.name,
            input: args,
          });
          if (response.error) {
            return { isError: true, content: [{ type: "text", text: response.error }] };
          }
          return { content: [{ type: "text", text: JSON.stringify(response.result ?? null) }] };
        },
      );
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}
