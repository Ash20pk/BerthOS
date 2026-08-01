import { randomUUID } from "node:crypto";
import Docker from "dockerode";
import {
  startContainer,
  stopContainer,
  createStdioRpcClient,
  invokeAppExport,
  type StdioRpcClient,
} from "@berth/docker-orchestrator";
import { resolveComputerApps, type ComputerAppSpec } from "./resolve-apps.js";
import { buildComputerImage } from "./build.js";
import { computerToolsFor } from "./tools.js";
import type { Tool } from "./types.js";

export interface BootComputerOptions {
  /** Directories, each containing a berth.yml, to load as resident apps into this computer. */
  apps: string[];
  /** Joins the container to a shared Docker network — see Crew.networked(). */
  network?: string;
  /** Extra container environment variables — e.g. an LLM API key for a synthesized agent-server companion app. */
  env?: Record<string, string>;
  docker?: Docker;
}

/**
 * No fabricated health-check export exists to poll — container boot (on_install,
 * the context-bus/semantic-fs daemons, capability-policy generation, agent-init's
 * Landlock setup) takes a few seconds before the app's RPC server is even
 * reading its stdin/socket. A request written before that point can be lost
 * rather than buffered (dockerode's hijacked attach stream + Docker's own
 * attach machinery, not a guarantee this code controls) — so each retry
 * re-issues a fresh request rather than waiting out one long-lived call.
 * READY_ATTEMPT_TIMEOUT_MS is deliberately much shorter than
 * createStdioRpcClient's own internal 30s timeout, so several attempts fit
 * inside the ceiling instead of the ceiling and one attempt being the same
 * number (which would leave no room to retry at all).
 */
const READY_RETRY_CEILING_MS = 30_000;
const READY_ATTEMPT_TIMEOUT_MS = 3_000;
const READY_RETRY_INITIAL_DELAY_MS = 250;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`attempt timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function withReadyRetry<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  let delay = READY_RETRY_INITIAL_DELAY_MS;
  for (;;) {
    try {
      return await withTimeout(fn(), READY_ATTEMPT_TIMEOUT_MS);
    } catch (err) {
      if (Date.now() - start >= READY_RETRY_CEILING_MS) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 2000);
    }
  }
}

/**
 * The runtime primitive: boots a real Docker sandbox loaded with N resident
 * apps and exposes their exports as a unified Tool[] list. This is the
 * "computer" in computer -> agent -> tool — Agent/Crew build on top of this,
 * but Computer has zero knowledge of any LLM.
 */
export class Computer {
  readonly tools: Tool[];
  readonly containerName: string;

  private constructor(
    private readonly container: Docker.Container,
    readonly apps: ComputerAppSpec[],
    private readonly stdioClient: StdioRpcClient | undefined,
    tools: Tool[],
    containerName: string,
    private readonly docker: Docker,
    private readonly image: string,
  ) {
    this.tools = tools;
    this.containerName = containerName;
  }

  static async boot(options: BootComputerOptions): Promise<Computer> {
    const docker = options.docker ?? new Docker();
    const apps = await resolveComputerApps(options.apps);
    const [primary] = apps;
    if (!primary) {
      throw new Error("Computer.boot() needs at least one app");
    }

    const image = await buildComputerImage(apps);
    const containerName = `berth-agent-${randomUUID()}`;

    const { container } = await startContainer({
      image,
      name: containerName,
      manifest: primary.manifest,
      apps:
        apps.length > 1
          ? apps.map((a) => ({ name: a.name, workingDir: `/app/apps/${a.name}`, manifest: a.manifest }))
          : undefined,
      network: options.network,
      env: options.env,
      docker,
    });

    // Single app: the container's own PID 1 stdio (attach, reused across
    // calls). Multi-app: no way to attach to a non-PID-1 process, so each
    // call goes through invokeAppExport's docker-exec + Unix-socket relay.
    const stdioClient = apps.length === 1 ? await createStdioRpcClient(container, docker) : undefined;

    const dispatch = async (appName: string, exportName: string, input: unknown): Promise<unknown> => {
      const request = { id: randomUUID(), export: exportName, input };
      const response = stdioClient
        ? await stdioClient.call(request)
        : await invokeAppExport(container, appName, request, { docker });
      if (response.error) throw new Error(response.error);
      return response.result;
    };

    const call = (appName: string, exportName: string, input: unknown) =>
      withReadyRetry(() => dispatch(appName, exportName, input));

    const tools = computerToolsFor(apps, call);

    return new Computer(container, apps, stdioClient, tools, containerName, docker, image);
  }

  async call(toolName: string, input: unknown): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(`no such tool "${toolName}" — available: ${this.tools.map((t) => t.name).join(", ")}`);
    }
    return tool.invoke(input);
  }

  /**
   * Every Computer.boot() builds a fresh, uniquely-tagged image (see
   * buildComputerImage) rather than reusing a stable tag the way `berth dev`/
   * `berth deploy` do — so nothing else references it, and leaving it behind
   * would just leak disk space across repeated boots. Best-effort: a
   * container the caller never actually started (a failed boot) or an image
   * Docker already reclaimed shouldn't turn a normal stop() into an error.
   */
  async stop(): Promise<void> {
    this.stdioClient?.close();
    await stopContainer(this.container);
    await this.docker
      .getImage(this.image)
      .remove()
      .catch(() => {});
  }
}
