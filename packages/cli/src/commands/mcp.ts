import { Command, Flags } from "@oclif/core";
import Docker from "dockerode";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadManifest } from "@berth/manifest-schema";
import { createStdioRpcClient, stopContainer } from "@berth/docker-orchestrator";
import { mcpToolsFor, parseOnlyExports } from "../util/mcp-tools.js";
import { bootDevContainer } from "../util/dev-boot.js";
import { resolveApps } from "../util/multi-app.js";
import { explainAppError, enforcementFromContainerLogs, type EnforcementStatus } from "../util/capability-errors.js";

/**
 * Bridges one resident app's already-declared exports to MCP tools, so an
 * MCP client (Claude Code, Claude Desktop, Cursor, …) can call them directly.
 * Targets a single-app container, where the app's runtime is PID 1 and
 * reachable directly over the container's own stdio (createStdioRpcClient) —
 * not `berth rpc`'s invokeAppExport, which relays to a per-app Unix socket
 * that only exists in multi-app-per-sandbox mode.
 *
 * Two things make this the *front door* rather than an extra integration
 * (launch plan 1.5):
 *
 *  - It boots the sandbox itself when one isn't already running. An MCP client
 *    spawns exactly one command, so "run `berth dev` in another terminal
 *    first" is a setup step with nowhere to live. `--no-boot` keeps the old
 *    attach-only behavior for anyone already running `berth dev`.
 *  - A denied tool call comes back as an explanation naming the manifest line
 *    that would allow it (see util/capability-errors.ts), because the reader
 *    on the other end of this transport is usually another agent, and
 *    `EACCES: permission denied, open '/etc/x'` says nothing about berth.yml.
 *
 * Note on output: stdout is the MCP transport. Every human-readable line this
 * command emits goes to stderr (this.warn / this.error / logStderr), and a
 * stray this.log() here would be a protocol framing error.
 *
 * Deliberately out of scope (see docs/mcp-bridge-reference.md): cryptographic
 * auth — there is still no token verifying *who* is calling, so anyone who can
 * spawn this command against a running container can use it; remote/
 * fleet-hosted apps; reaching a companion app inside a multi-app container;
 * and non-stdio transports.
 */
export default class Mcp extends Command {
  static override description =
    "Expose a resident app's declared exports as MCP tools over stdio, booting the app's sandbox if it isn't already running";
  static override examples = [
    "<%= config.bin %> mcp --app filesystem --app-dir apps/filesystem",
    "<%= config.bin %> mcp --app filesystem --app-dir apps/filesystem --only write_file,read_file",
    "<%= config.bin %> mcp --app filesystem --app-dir apps/filesystem --no-boot",
  ];
  static override flags = {
    app: Flags.string({ required: true, description: "the app's name (as declared in its berth.yml)" }),
    container: Flags.string({ description: "container name to reach (defaults to berth-dev-<app>)" }),
    "app-dir": Flags.string({ description: "path to the app's directory (defaults to the current directory)", default: "." }),
    only: Flags.string({
      description:
        "comma-separated export names to bridge — omit to bridge every export declared in berth.yml (today's default, unchanged). Scopes an MCP client to least privilege instead of blanket access to everything the app can do.",
    }),
    boot: Flags.boolean({
      allowNo: true,
      default: true,
      description:
        "build and start the app's sandbox if no container is already running (default). --no-boot fails instead, for when `berth dev` is already up.",
    }),
    warm: Flags.boolean({
      default: false,
      description:
        "build the image, boot the sandbox, wait for the app to report ready, then stop it and exit 0 — without serving MCP. Run this once before wiring up a client: the first build takes minutes and an MCP client will kill a server that can't answer `initialize` inside its startup timeout.",
    }),
    "boot-timeout": Flags.integer({
      default: 120,
      description: "seconds to wait for a freshly booted app's runtime to report ready",
    }),
  };

  private logStderr(message: string): void {
    process.stderr.write(`[berth:mcp] ${message}\n`);
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Mcp);
    const appName = flags.app;
    // Absolute, because the boot path bind-mounts this directory (or the
    // workspace root above it): Docker reads a relative source as a *volume
    // name*, and the failure is a "volume name is too short" 400 rather than
    // anything about paths.
    const appDir = resolve(flags["app-dir"]);
    const containerName = flags.container ?? `berth-dev-${appName}`;

    const manifest = await loadManifest(`${appDir}/berth.yml`).catch((err: unknown) => {
      this.error(`couldn't load berth.yml from "${appDir}": ${err instanceof Error ? err.message : String(err)}`);
    });
    if (manifest.name !== appName) {
      this.warn(`--app=${appName} doesn't match berth.yml's declared name "${manifest.name}" — proceeding with --app's value for the RPC target`);
    }

    const declaredExportNames = manifest.exports.map((e) => e.name);
    const only = flags.only ? parseOnlyExports(flags.only, declaredExportNames) : undefined;
    if (only && only.unknown.length > 0) {
      this.error(
        `--only names export(s) not declared in "${appName}"'s berth.yml: ${only.unknown.join(", ")} — declared exports: ${declaredExportNames.join(", ") || "(none)"}`,
      );
    }

    const docker = new Docker();
    let container = docker.getContainer(containerName);
    let bootedHere = false;
    try {
      await container.inspect();
      this.logStderr(`attached to the running container "${containerName}"`);
    } catch {
      if (!flags.boot) {
        this.error(
          `no running container named "${containerName}" and --no-boot was passed — start it with \`berth dev\` in ${appDir}, or drop --no-boot to let this command boot it (pass --container if it runs under a different name)`,
        );
      }
      this.logStderr(`no container named "${containerName}" — booting the sandbox for "${manifest.name}" (this builds an image on first run)`);
      const apps = await resolveApps(appDir, undefined, manifest);
      const running = await bootDevContainer({
        appDir,
        manifest,
        apps,
        docker,
        containerName,
        log: (message) => this.logStderr(message),
      });
      container = running.container;
      bootedHere = true;
      await this.waitForRuntime(container, manifest.name, flags["boot-timeout"] * 1000);
    }

    // agent-init's own statement about what the kernel did with the declared
    // policy. Read once, here, so a denial can be attributed honestly rather
    // than presented as kernel enforcement on a host where nothing was
    // enforced (`berth doctor` is the host-level version of this check).
    const enforcement = await this.readEnforcement(container);
    this.logStderr(`kernel enforcement in this container: ${enforcement}${enforcement === "enforced" ? "" : " — run `berth doctor`"}`);

    if (flags.warm) {
      // Deliberately symmetric with the serving path's ownership rule: a
      // container this command booted is one it stops. An already-running
      // `berth dev` container is left exactly as it was found.
      if (bootedHere) {
        this.logStderr(`stopping the sandbox this warm-up booted ("${containerName}")`);
        await stopContainer(container).catch(() => {});
      }
      this.logStderr(`warm: image built and "${manifest.name}" reached ready — an MCP client can now start this server inside its timeout`);
      return;
    }

    const rpc = await createStdioRpcClient(container, docker);

    const transport = new StdioServerTransport();

    // The container outlives this process only if it already existed. One that
    // this command booted is torn down with it, so an MCP client that stops
    // the server doesn't leave a sandbox running with no owner.
    if (bootedHere) {
      let stopping = false;
      const shutdown = () => {
        if (stopping) return;
        stopping = true;
        void stopContainer(container)
          .catch(() => {})
          .then(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      // Not just signals: a client that closes the pipe instead of signalling
      // (and `berth mcp < /dev/null`) ends stdin, and the transport's onclose
      // is the only notice this process gets. Without it the sandbox outlives
      // the bridge that owns it, with nothing left to stop it.
      transport.onclose = shutdown;
      process.stdin.on("end", shutdown);
    }

    const server = new McpServer({ name: `berth-${appName}`, version: manifest.version });
    const allowed = only ? new Set(only.names) : undefined;

    for (const tool of mcpToolsFor(manifest)) {
      if (allowed && !allowed.has(tool.name)) continue;
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
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: explainAppError(response.error, {
                    appName: manifest.name,
                    manifest,
                    manifestPath: `${appDir}/berth.yml`,
                    enforcement,
                  }),
                },
              ],
            };
          }
          return { content: [{ type: "text", text: JSON.stringify(response.result ?? null) }] };
        },
      );
    }

    await server.connect(transport);
  }

  /**
   * A freshly booted container answers RPC only once the app's runtime has
   * loaded its manifest and registered its exports. Without this wait the
   * first tools/call after an auto-boot times out against a container that is
   * perfectly healthy and just not ready yet.
   *
   * Polled rather than streamed on purpose: a followed log stream that never
   * produces another chunk (an app that died silently, an image that hangs in
   * its entrypoint) would sit past the deadline, because the deadline is only
   * ever checked when a chunk arrives.
   */
  private async waitForRuntime(container: Docker.Container, appName: string, timeoutMs: number): Promise<void> {
    const ready = new RegExp(`"${appName}" ready`);
    const deadline = Date.now() + timeoutMs;
    let seen = "";
    while (Date.now() < deadline) {
      seen = await this.readLogs(container);
      if (ready.test(seen)) {
        this.logStderr(`"${appName}" is ready`);
        return;
      }
      const state = await container.inspect().catch(() => undefined);
      if (state && !state.State.Running) {
        this.error(
          `"${appName}"'s container exited (code ${state.State.ExitCode}) before its runtime reported ready. Its output:\n${lastLines(seen)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    this.error(
      `"${appName}" did not report ready within ${Math.round(timeoutMs / 1000)}s of boot — run \`berth dev\` in its directory to watch the container's own output. Last log lines:\n${lastLines(seen)}`,
    );
  }

  private async readLogs(container: Docker.Container, tail = 500): Promise<string> {
    try {
      const logs = await container.logs({ stdout: true, stderr: true, tail });
      return logs.toString("utf-8");
    } catch {
      return "";
    }
  }

  private async readEnforcement(container: Docker.Container): Promise<EnforcementStatus> {
    return enforcementFromContainerLogs(await this.readLogs(container));
  }
}

/** The tail of a container's own output, for an error message a human will read. */
function lastLines(logs: string, count = 15): string {
  return logs.split("\n").slice(-count).join("\n");
}
