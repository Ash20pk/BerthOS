import { randomUUID, randomBytes } from "node:crypto";
import Docker from "dockerode";
import {
  startContainer,
  stopContainer,
  createStdioRpcClient,
  invokeAppExport,
  readOsState,
  type StdioRpcClient,
} from "@berth/docker-orchestrator";
import { resolveComputerApps, type ComputerAppSpec } from "./resolve-apps.js";
import { buildComputerImage } from "./build.js";
import { computerToolsFor } from "./tools.js";
import { applyGovernanceGate } from "./governance.js";
import type { Tool } from "./types.js";

export interface BootComputerOptions {
  /** Directories, each containing a berth.yml, to load as resident apps into this computer. */
  apps: string[];
  /** Joins the container to a shared Docker network — see Crew.networked(). */
  network?: string;
  /** Extra container environment variables — e.g. an LLM API key for a synthesized agent-server companion app. */
  env?: Record<string, string>;
  /**
   * Also starts @berth/sdk's HTTP RPC bridge inside the container (see
   * container.ts's `httpRpc` option) and exposes it on the returned handle's
   * `httpRpc` field — the one way a process with no Docker API access (a
   * Python client, see packages/agents-python's `Computer.connect()`) can
   * reach this Computer's tools. `app` names which of `apps` should bind the
   * listener when there's more than one (defaults to the first); only that
   * one app's exports are reachable via the bridge, same
   * BERTH_HTTP_RPC_APP-gated limitation a remote fleet deploy has. Omitted
   * (the default), this Computer works exactly as before — dispatch stays
   * stdio/docker-exec only, nothing extra starts.
   */
  httpRpc?: boolean | { app?: string };
  docker?: Docker;
}

export interface ConnectComputerOptions {
  /** Name passed to `berth os up <name>` — resolved via ~/.berth/os/<name>.json (see docs/berth-os-reference.md). */
  name: string;
  /**
   * Restrict this Computer to a subset of the OS's loaded apps, by name —
   * e.g. an OS started with `--apps=apps/filesystem,apps/notes,apps/terminal`
   * still exists as one shared container, but a specific agent can connect
   * with `apps: ["filesystem"]` and get a tool list scoped to just that one
   * app, without needing a second `berth os up` instance. Omit to get every
   * app the OS has loaded.
   */
  apps?: string[];
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
export const READY_RETRY_CEILING_MS = 30_000;
const READY_ATTEMPT_TIMEOUT_MS = 3_000;
const READY_RETRY_INITIAL_DELAY_MS = 250;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
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

/**
 * Exported for fleet-computer.ts to reuse against a completely different
 * "is it ready yet" check (a deployed instance reaching `running` status,
 * or its RPC bridge answering /healthz) — same retry/backoff shape, no
 * reason to duplicate it just because the thing being polled differs.
 */
export async function withReadyRetry<T>(fn: () => Promise<T>, ceilingMs = READY_RETRY_CEILING_MS): Promise<T> {
  const start = Date.now();
  let delay = READY_RETRY_INITIAL_DELAY_MS;
  for (;;) {
    try {
      return await withTimeout(fn(), READY_ATTEMPT_TIMEOUT_MS);
    } catch (err) {
      if (Date.now() - start >= ceilingMs) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 2000);
    }
  }
}

/**
 * What createAgent()/bootNetworkedAgent() actually need from a Computer,
 * regardless of whether it's a local Docker container (Computer itself) or a
 * remote fleet instance (fleet-computer.ts's HttpBridgeComputer) — the only
 * two things ever consumed across that boundary are the tool list and a way
 * to call one, plus lifecycle teardown. Local Docker's stop() also removes a
 * built image and closes a stdio client; a fleet instance's stop() tears
 * down the deployed instance via its DeployAdapter — different internals,
 * identical shape from the caller's side.
 */
export interface ComputerHandle {
  readonly tools: Tool[];
  call(toolName: string, input: unknown): Promise<unknown>;
  stop(): Promise<void>;
  /**
   * Set only when this handle was booted/connected with the HTTP RPC bridge
   * enabled — see BootComputerOptions.httpRpc. `appName` is which app's
   * exports are actually reachable through it (undefined for a single-app
   * Computer). Undefined for every other Computer/HttpBridgeComputer.
   */
  readonly httpRpc?: { url: string; authToken: string; appName?: string };
}

/**
 * The runtime primitive: boots a real Docker sandbox loaded with N resident
 * apps and exposes their exports as a unified Tool[] list. This is the
 * "computer" in computer -> agent -> tool — Agent/Crew build on top of this,
 * but Computer has zero knowledge of any LLM.
 */
export class Computer implements ComputerHandle {
  readonly tools: Tool[];
  readonly containerName: string;
  readonly httpRpc: ComputerHandle["httpRpc"];

  private constructor(
    private readonly container: Docker.Container,
    readonly apps: ComputerAppSpec[],
    private readonly stdioClient: StdioRpcClient | undefined,
    tools: Tool[],
    containerName: string,
    private readonly docker: Docker,
    private readonly image: string | undefined,
    /** False for a Computer obtained via connect() — see stop(). */
    private readonly ownsLifecycle: boolean,
    httpRpc: ComputerHandle["httpRpc"],
  ) {
    this.tools = tools;
    this.containerName = containerName;
    this.httpRpc = httpRpc;
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

    const httpRpcRequested = !!options.httpRpc;
    const httpRpcAuthToken = httpRpcRequested ? randomBytes(32).toString("hex") : undefined;
    // Only meaningful (and only sent to startContainer as BERTH_HTTP_RPC_APP)
    // once there's more than one app to disambiguate — an explicit `app`
    // still has to be one of `apps`, checked below rather than silently
    // accepted and failing opaquely inside the container instead.
    const httpRpcAppName =
      typeof options.httpRpc === "object" ? options.httpRpc.app : apps.length > 1 ? apps[0]!.name : undefined;
    if (httpRpcAppName && !apps.some((a) => a.name === httpRpcAppName)) {
      throw new Error(`httpRpc.app "${httpRpcAppName}" isn't one of this Computer's apps: ${apps.map((a) => a.name).join(", ")}`);
    }

    const { container, ports } = await startContainer({
      image,
      name: containerName,
      manifest: primary.manifest,
      apps:
        apps.length > 1
          ? apps.map((a) => ({ name: a.name, workingDir: `/app/apps/${a.name}`, manifest: a.manifest }))
          : undefined,
      network: options.network,
      env: options.env,
      httpRpc: httpRpcRequested ? { authToken: httpRpcAuthToken!, appName: httpRpcAppName } : undefined,
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

    const tools = applyGovernanceGate(apps, apps, computerToolsFor(apps, call), call);

    let httpRpc: ComputerHandle["httpRpc"];
    if (httpRpcRequested) {
      // A failure here (a full withReadyRetry timeout, or no host port at
      // all) previously left the just-started container running with
      // nothing referencing it — the same orphaned-container class of bug
      // HttpBridgeComputer.deploy() already guards against for a remote
      // instance. Stop it before rethrowing, mirroring that.
      try {
        if (!ports.httpRpc) {
          throw new Error("httpRpc was requested but the container never published a host port for it");
        }
        const url = `http://127.0.0.1:${ports.httpRpc}`;
        // A longer ceiling than withReadyRetry's own default (30s, tuned
        // for retrying an individual dispatch call, not a cold boot): a
        // fresh container's context-bus/semantic-fs daemons, capability
        // policy generation, and agent-init's Landlock setup all run before
        // the app process is even listening, and a shared/cold CI runner is
        // measurably slower at this than a dev machine that's already
        // booted this image before.
        await withReadyRetry(() => checkHttpRpcHealth(url, httpRpcAuthToken!), 60_000);
        httpRpc = { url, authToken: httpRpcAuthToken!, appName: httpRpcAppName };
      } catch (err) {
        stdioClient?.close();
        await stopContainer(container).catch(() => {});
        await docker
          .getImage(image)
          .remove()
          .catch(() => {});
        throw err;
      }
    }

    return new Computer(container, apps, stdioClient, tools, containerName, docker, image, true, httpRpc);
  }

  /**
   * Attaches to a container already started by `berth os up <name>` instead
   * of building an image and booting a fresh one — the fix for cold start:
   * a dev iterating on agent code pays the build+boot cost once (`berth os
   * up`), then every subsequent run just reconnects in milliseconds. Always
   * dispatches via invokeAppExport's docker-exec + Unix-socket relay (never
   * stdio) — `berth os up` forces entrypoint.sh's multi-app branch even for
   * a single app specifically so this always has a per-app socket to reach,
   * regardless of how many apps are loaded. See docs/berth-os-reference.md.
   */
  static async connect(options: ConnectComputerOptions): Promise<Computer> {
    const docker = options.docker ?? new Docker();
    const state = await readOsState(options.name);
    if (!state) {
      throw new Error(`no Berth OS named "${options.name}" — start one first with \`berth os up ${options.name} --apps=<dir1>,<dir2>\``);
    }

    const container = docker.getContainer(state.containerName);
    try {
      const info = await container.inspect();
      if (!info.State.Running) throw new Error("not running");
    } catch {
      throw new Error(`"${options.name}" (container ${state.containerName}) isn't running — run \`berth os up ${options.name}\` again`);
    }

    let appRecords = state.apps;
    if (options.apps) {
      const missing = options.apps.filter((name) => !state.apps.some((a) => a.name === name));
      if (missing.length > 0) {
        throw new Error(
          `"${options.name}" doesn't have these apps loaded: ${missing.join(", ")} — it has: ${state.apps.map((a) => a.name).join(", ") || "(none)"}`,
        );
      }
      appRecords = state.apps.filter((a) => options.apps!.includes(a.name));
    }

    const apps = await resolveComputerApps(appRecords.map((a) => a.appDir));
    // Deliberately the OS's *full* loaded-app list, not just `apps` — a
    // governance app running in this container still has to gate tool calls
    // even when this particular connect() only exposes a subset that
    // doesn't happen to include it by name. See applyGovernanceGate's own
    // doc comment. Only resolved a second time when scoping actually
    // narrowed the list; otherwise `apps` already covers everything.
    const allApps = options.apps ? await resolveComputerApps(state.apps.map((a) => a.appDir)) : apps;

    const dispatch = async (appName: string, exportName: string, input: unknown): Promise<unknown> => {
      const request = { id: randomUUID(), export: exportName, input };
      const response = await invokeAppExport(container, appName, request, { docker });
      if (response.error) throw new Error(response.error);
      return response.result;
    };

    const call = (appName: string, exportName: string, input: unknown) => withReadyRetry(() => dispatch(appName, exportName, input));

    const tools = applyGovernanceGate(allApps, apps, computerToolsFor(apps, call), call);

    // Passed through as a plain read of what `berth os up --http-rpc`
    // recorded, not re-verified live here — connect() already has a working
    // dispatch path via invokeAppExport regardless, so this is only useful
    // for a caller that wants to hand the URL/token to something else (e.g.
    // a Python subprocess) rather than something this method depends on.
    const httpRpc = state.httpRpc ? { url: state.httpRpc.url, authToken: state.httpRpc.token, appName: state.httpRpc.app } : undefined;

    return new Computer(container, apps, undefined, tools, state.containerName, docker, undefined, false, httpRpc);
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
   *
   * A no-op for a Computer obtained via connect(): that container is a
   * long-lived OS other agent runs may still be using, owned by `berth os
   * up`/`berth os down`, not by this process — tearing it down here would
   * defeat the entire point of connecting to it instead of booting fresh.
   */
  async stop(): Promise<void> {
    this.stdioClient?.close();
    if (!this.ownsLifecycle) return;
    await stopContainer(this.container);
    if (this.image) {
      await this.docker
        .getImage(this.image)
        .remove()
        .catch(() => {});
    }
  }
}

/**
 * Same check fleet-computer.ts's healthCheck() does against a remote
 * instance's bridge, against a local container's host-mapped port instead —
 * a published port can accept TCP connections before the resident app
 * inside has actually started listening on its own end.
 */
async function checkHttpRpcHealth(url: string, authToken: string): Promise<void> {
  const res = await fetch(`${url}/healthz`, { headers: { authorization: `Bearer ${authToken}` } });
  if (!res.ok) throw new Error(`healthz check against ${url} returned ${res.status}`);
}
