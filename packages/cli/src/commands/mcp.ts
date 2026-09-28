import { Command, Flags } from "@oclif/core";
import Docker from "dockerode";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadManifest } from "@berthos/manifest-schema";
import { createFileAuditSink, defaultAuditPath } from "@berthos/audit";
import {
  createStdioRpcClient,
  gatherBootEvidence,
  removeContainerSecretsDir,
  stopContainer,
  stopSemanticFsSidecar,
  type StdioRpcClient,
} from "@berthos/docker-orchestrator";
import { mcpToolsFor, parseOnlyExports } from "../util/mcp-tools.js";
import { bootDevContainer } from "../util/dev-boot.js";
import { resolveApps } from "../util/multi-app.js";
import { explainAppError, enforcementFromContainerLogs, type EnforcementStatus } from "../util/capability-errors.js";
import { createRunAudit, newRunId, type RunAudit } from "../util/run-audit.js";
import { createInFlightCalls, createShutdown, handleToolCall, onClientPipesClosed } from "../util/mcp-call.js";
import { startBackgroundSandbox, type SandboxSteps } from "../util/mcp-sandbox.js";

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
 *  - It boots the sandbox itself when one isn't already running, in the
 *    background, after answering `initialize`. An MCP client
 *    spawns exactly one command, so "run `berth dev` in another terminal
 *    first" is a setup step with nowhere to live. `--no-boot` keeps the old
 *    attach-only behavior for anyone already running `berth dev`.
 *  - A denied tool call comes back as an explanation naming the manifest line
 *    that would allow it (see util/capability-errors.ts), because the reader
 *    on the other end of this transport is usually another agent, and
 *    `EACCES: permission denied, open '/etc/x'` says nothing about berth.yml.
 *
 * Every tool call is written to the audit trail (~/.berth/audit/audit.jsonl
 * unless --audit-file says otherwise) under one run id per session, along
 * with the sandbox's boot evidence, so the session can be checked with
 * `berth audit verify` and attested with `berth attest <runId>` after the
 * sandbox is gone. See util/run-audit.ts.
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
    "<%= config.bin %> mcp --app filesystem --app-dir apps/filesystem --run-id nightly-2026-09-28",
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
        "build the image, boot the sandbox, wait for the app to report ready, then stop it and exit 0 — without serving MCP. The bridge answers `initialize` without waiting for a boot, but its first tool call waits for the image to build; this makes that call fast.",
    }),
    audit: Flags.boolean({
      allowNo: true,
      default: true,
      description:
        "record every tool call, and the sandbox's boot evidence, in the audit trail under this session's run id (default). Inputs and outputs are not recorded, only which export was called, when, and whether it was allowed, denied or failed.",
    }),
    "audit-file": Flags.string({ description: "audit file to append to (defaults to ~/.berth/audit/audit.jsonl)" }),
    "run-id": Flags.string({
      description: "run id to record this session under, for `berth attest <runId>` (defaults to a new one, printed on stderr at start)",
    }),
    "boot-timeout": Flags.integer({
      default: 120,
      description: "seconds to wait for a freshly booted app's runtime to report ready",
    }),
    "call-timeout": Flags.integer({
      default: 30,
      description:
        "seconds to wait for the app to answer a tool call. A call whose input has a `timeout_ms` (code-interpreter's run_code) waits that long plus 15s if it is longer.",
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

    const noBootMessage = `no running container named "${containerName}" and --no-boot was passed — start it with \`berth dev\` in ${appDir}, or drop --no-boot to let this command boot it (pass --container if it runs under a different name)`;

    if (flags.warm) {
      // Deliberately symmetric with the serving path's ownership rule: a
      // container this command booted is one it stops. An already-running
      // `berth dev` container is left exactly as it was found.
      const sandbox = startBackgroundSandbox(this.sandboxSteps(docker, containerName, manifest, appDir, flags, { attachRpc: false }), {
        allowBoot: flags.boot,
        noBootMessage,
      });
      const stopWarm = () => void sandbox.stop().finally(() => process.exit(1));
      for (const signal of SHUTDOWN_SIGNALS) process.on(signal, stopWarm);
      onClientPipesClosed(process, stopWarm);
      const { bootedHere } = await sandbox.ready.catch((err: unknown) => this.error(errorMessage(err)));
      if (bootedHere) await sandbox.stop();
      this.logStderr(`warm: image built and "${manifest.name}" reached ready — an MCP client can now start this server inside its timeout`);
      return;
    }

    // --no-boot with nothing to attach to is a setup error, reported before
    // serving rather than on the first tool call.
    if (!flags.boot && !(await docker.getContainer(containerName).inspect().then(() => true, () => false))) {
      this.error(noBootMessage);
    }

    const transport = new StdioServerTransport();
    const server = new McpServer({ name: `berth-${appName}`, version: manifest.version });

    let runAudit: RunAudit | undefined;
    if (flags.audit) {
      const auditPath = flags["audit-file"] ?? defaultAuditPath(homedir());
      runAudit = createRunAudit({
        sink: createFileAuditSink({ path: auditPath }),
        runId: flags["run-id"] ?? newRunId(manifest.name),
        app: manifest.name,
        containerName,
        via: "mcp",
        // The client names itself in `initialize`, and nothing checks it.
        actor: () => ({ kind: "agent", id: server.server.getClientVersion()?.name ?? "mcp-client", verifiedBy: "self-asserted" }),
        operator: { kind: "operator", id: userInfo().username, verifiedBy: "self-asserted" },
      });
      const fileFlag = flags["audit-file"] ? ` --file ${auditPath}` : "";
      this.logStderr(`recording tool calls in ${auditPath} as run ${runAudit.runId} — attest it with \`berth attest ${runAudit.runId}${fileFlag}\``);
    }

    // The sandbox comes up in the background, after the server is connected:
    // the tool list comes from berth.yml, so `initialize` and `tools/list`
    // need nothing running. A first boot builds an image and can take
    // minutes, longer than an MCP client waits for a server to answer
    // `initialize` (about 60 s); tool calls wait for it instead.
    const sandbox = startBackgroundSandbox(this.sandboxSteps(docker, containerName, manifest, appDir, flags, { attachRpc: true }), {
      allowBoot: flags.boot,
      noBootMessage,
    });
    sandbox.ready.catch((err: unknown) => this.logStderr(`the sandbox didn't start: ${errorMessage(err)}`));

    // Recorded once the sandbox is up; awaited before a sandbox this command
    // booted is stopped, since the evidence can only be read from a running one.
    let bootEvidence: Promise<void> = Promise.resolve();
    const inFlight = createInFlightCalls();

    // The container outlives this process only if it already existed. One that
    // this command booted is torn down with it, so an MCP client that stops
    // the server doesn't leave a sandbox running with no owner. Registered
    // before the boot finishes, so a client that goes away mid-boot still
    // gets it stopped. Either way, calls still in flight are recorded as
    // interrupted before exiting.
    const shutdown = createShutdown({
      // Only a sandbox that is up has evidence to record; one still booting
      // is stopped straight away rather than waited for.
      pending: () => (sandbox.state() === "ready" ? bootEvidence : Promise.resolve()),
      pendingTimeoutMs: 60_000,
      interrupt: () => inFlight.interruptAll(runAudit),
      stop: () => sandbox.stop(),
      exit: () => process.exit(0),
    });
    for (const signal of SHUTDOWN_SIGNALS) process.on(signal, () => void shutdown({ urgent: true }));
    // Not just signals: a client that closes the pipe instead of signalling
    // (and `berth mcp < /dev/null`) ends stdin, and the transport's onclose
    // is the only notice this process gets. Without it the sandbox outlives
    // the bridge that owns it, with nothing left to stop it.
    transport.onclose = () => void shutdown();
    process.stdin.on("end", () => void shutdown());
    onClientPipesClosed(process, () => void shutdown());

    const allowed = only ? new Set(only.names) : undefined;
    const explain = (error: string, enforcement: EnforcementStatus) =>
      explainAppError(error, { appName: manifest.name, manifest, manifestPath: `${appDir}/berth.yml`, enforcement });

    for (const tool of mcpToolsFor(manifest)) {
      if (allowed && !allowed.has(tool.name)) continue;
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputShape }, async (args: Record<string, unknown>, extra) => {
        // Bounded, and abandoned once the client cancels: a call made during
        // a long boot used to wait for it however long it took, then run
        // after the client had long since given up on it.
        let ready: Awaited<typeof sandbox.ready>;
        try {
          ready = await sandbox.whenReady({ waitMs: flags["boot-timeout"] * 1000, signal: extra.signal });
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `the "${manifest.name}" sandbox isn't available: ${errorMessage(err)}` }] };
        }
        return handleToolCall(
          {
            export: tool.name,
            call: (request, options) => ready.rpc!.call(request, options),
            explain: (error) => explain(error, ready.enforcement),
            runAudit,
            callTimeoutMs: flags["call-timeout"] * 1000,
            inFlight,
          },
          args,
          extra.signal,
        );
      });
    }

    await server.connect(transport);
    if (runAudit) {
      bootEvidence = sandbox.ready.then(
        ({ container }) => this.recordBootEvidence(runAudit, docker, container, containerName),
        () => undefined,
      );
    }
  }

  /**
   * The Docker side of the session's sandbox, for startBackgroundSandbox
   * (util/mcp-sandbox.ts), which decides when each step runs and what gets
   * stopped. Stopping is by name: the name is fixed before anything is
   * created, so a boot that is interrupted or fails partway (after its
   * semantic-fs sidecar started, or its container was created) is cleaned
   * up whether or not it got as far as handing the container back.
   */
  private sandboxSteps(
    docker: Docker,
    containerName: string,
    manifest: Awaited<ReturnType<typeof loadManifest>>,
    appDir: string,
    flags: { "boot-timeout": number },
    options: { attachRpc: boolean },
  ): SandboxSteps<Docker.Container, { container: Docker.Container; enforcement: EnforcementStatus; rpc?: StdioRpcClient }> {
    return {
      find: async () => {
        const existing = docker.getContainer(containerName);
        if (!(await existing.inspect().then(() => true, () => false))) return undefined;
        this.logStderr(`attached to the running container "${containerName}"`);
        return existing;
      },
      boot: async () => {
        this.logStderr(`no container named "${containerName}" — booting the sandbox for "${manifest.name}" (this builds an image on first run)`);
        const apps = await resolveApps(appDir, undefined, manifest);
        const running = await bootDevContainer({ appDir, manifest, apps, docker, containerName, log: (message) => this.logStderr(message) });
        return running.container;
      },
      waitReady: (container, signal) => this.waitForRuntime(container, manifest.name, flags["boot-timeout"] * 1000, signal),
      connect: async (container) => {
        // agent-init's own statement about what the kernel did with the
        // declared policy. Read once, here, so a denial can be attributed
        // honestly rather than presented as kernel enforcement on a host
        // where nothing was enforced (`berth doctor` is the host-level version).
        const enforcement = await this.readEnforcement(container);
        this.logStderr(`kernel enforcement in this container: ${enforcement}${enforcement === "enforced" ? "" : " — run `berth doctor`"}`);
        return { container, enforcement, ...(options.attachRpc ? { rpc: await createStdioRpcClient(container, docker) } : {}) };
      },
      stopByName: async () => {
        this.logStderr(`stopping the sandbox this session booted ("${containerName}")`);
        await stopSemanticFsSidecar(containerName, docker).catch(() => {});
        await stopContainer(docker.getContainer(containerName), { docker }).catch(() => {});
        await removeContainerSecretsDir(containerName).catch(() => {});
      },
    };
  }

  /**
   * The same evidence `berth attest` reads from a live container, captured
   * while this session's sandbox is running and written into the run's audit
   * trail. A failure is reported and the session carries on: an unattestable
   * run is still a usable one.
   */
  private async recordBootEvidence(runAudit: RunAudit, docker: Docker, container: Docker.Container, containerName: string): Promise<void> {
    try {
      const image = (await container.inspect()).Config.Image;
      const evidence = await gatherBootEvidence(docker, containerName, image);
      await runAudit.sandboxBoot(evidence);
      this.logStderr(`recorded boot evidence for run ${runAudit.runId} (boot ${evidence.bootId})`);
    } catch (err) {
      this.logStderr(`could not record boot evidence (${err instanceof Error ? err.message : String(err)}) — tool calls are still audited, but \`berth attest\` will need a running sandbox for this run`);
    }
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
  private async waitForRuntime(container: Docker.Container, appName: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const ready = new RegExp(`"${appName}" ready`);
    const deadline = Date.now() + timeoutMs;
    let seen = "";
    while (Date.now() < deadline && !signal?.aborted) {
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
    if (signal?.aborted) throw new Error(`the session ended while waiting for "${appName}" to report ready`);
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

/**
 * SIGHUP too: it is what a client's terminal or process group sends when it
 * goes away, and left unhandled it kills the process on the spot, leaving a
 * sandbox this session booted running with no owner.
 */
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The tail of a container's own output, for an error message a human will read. */
function lastLines(logs: string, count = 15): string {
  return logs.split("\n").slice(-count).join("\n");
}
