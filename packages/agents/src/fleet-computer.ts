import { randomBytes } from "node:crypto";
import type { DeployAdapter, DeployHandle, DeployTarget } from "@berth/adapter-core";
import { withReadyRetry, READY_RETRY_CEILING_MS, type ComputerHandle } from "./computer.js";
import { computerToolsFor } from "./tools.js";
import { applyGovernanceGate } from "./governance.js";
import type { ComputerAppSpec } from "./resolve-apps.js";
import type { Tool } from "./types.js";

export interface DeployComputerOptions {
  adapter: DeployAdapter;
  /** Port the deployed instance's HTTP RPC bridge listens on — see @berth/sdk's startHttpRpcServer. */
  port: number;
  imageRef: string;
  manifest: DeployTarget["manifest"];
  /** Every app loaded into the deployed instance — same shape Computer.boot() builds tools from. */
  apps: ComputerAppSpec[];
  /** Which of `apps` should bind the HTTP RPC listener — see runtime.ts's BERTH_HTTP_RPC_APP gating. Omit for a single-app deploy. */
  rpcAppName?: string;
  env?: Record<string, string>;
  /** How long to keep retrying "is the instance running yet / does rpcUrl() have an answer / is the bridge healthy" before giving up. Defaults to computer.ts's own READY_RETRY_CEILING_MS; mainly useful for tests. */
  readyTimeoutMs?: number;
}

/**
 * Backs a Computer-shaped object with a peer deployed to a remote fleet
 * (E2B, Daytona, K8s) instead of a local Docker container — see
 * bootNetworkedAgent({fleet}) in network.ts. Dispatches over the HTTP RPC
 * bridge (@berth/sdk's startHttpRpcServer) via the adapter's rpcUrl(),
 * since none of these providers' SDKs expose anything like Computer's own
 * dockerode-specific invokeAppExport()/createStdioRpcClient() (confirmed:
 * no DeployAdapter implementation can docker-exec/attach into an already-
 * running remote instance).
 */
export class HttpBridgeComputer implements ComputerHandle {
  readonly tools: Tool[];

  private constructor(
    private readonly adapter: DeployAdapter,
    private readonly handle: DeployHandle,
    tools: Tool[],
  ) {
    this.tools = tools;
  }

  static async deploy(options: DeployComputerOptions): Promise<HttpBridgeComputer> {
    if (!options.adapter.rpcUrl) {
      throw new Error(`the "${options.adapter.name}" deploy adapter doesn't support rpcUrl() — can't reach a resident app's exports on it`);
    }

    const authToken = randomBytes(32).toString("hex");
    const target: DeployTarget = {
      imageRef: options.imageRef,
      manifest: options.manifest,
      env: {
        ...options.env,
        BERTH_HTTP_RPC_PORT: String(options.port),
        BERTH_HTTP_RPC_TOKEN: authToken,
        ...(options.rpcAppName ? { BERTH_HTTP_RPC_APP: options.rpcAppName } : {}),
      },
    };

    const { remoteImageRef } = await options.adapter.upload(target);
    const handle = await options.adapter.start(remoteImageRef, target);

    try {
      const rpcUrl = await bringUpRpcBridge(options.adapter, handle, options.port, authToken, options.readyTimeoutMs ?? READY_RETRY_CEILING_MS);
      const call = (_appName: string, exportName: string, input: unknown) => dispatch(rpcUrl, authToken, exportName, input);
      const tools = applyGovernanceGate(options.apps, computerToolsFor(options.apps, call));
      return new HttpBridgeComputer(options.adapter, handle, tools);
    } catch (err) {
      await options.adapter.teardown(handle).catch(() => {});
      throw new Error(
        `failed to bring up a Computer via the "${options.adapter.name}" fleet adapter: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async call(toolName: string, input: unknown): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(`no such tool "${toolName}" — available: ${this.tools.map((t) => t.name).join(", ")}`);
    }
    return tool.invoke(input);
  }

  async stop(): Promise<void> {
    await this.adapter.teardown(this.handle);
  }
}

/**
 * Three things have to be true before this Computer is safe to hand back:
 * the instance itself is "running", the adapter has a URL for the RPC port,
 * and that URL's bridge is actually answering — a preview/rpc URL can exist
 * before the resident app inside has finished booting. Reuses computer.ts's
 * own retry/backoff shape (same ceiling) rather than inventing a second one.
 */
async function bringUpRpcBridge(
  adapter: DeployAdapter,
  handle: DeployHandle,
  port: number,
  authToken: string,
  readyTimeoutMs: number,
): Promise<string> {
  await withReadyRetry(async () => {
    const status = await handle.status();
    if (status !== "running") throw new Error(`instance is "${status}", not "running" yet`);
  }, readyTimeoutMs);

  const rpcUrl = await withReadyRetry(async () => {
    const url = await adapter.rpcUrl!(handle, port);
    if (!url) throw new Error("rpcUrl() has no URL for this instance/port yet");
    return url;
  }, readyTimeoutMs);

  await withReadyRetry(() => healthCheck(rpcUrl, authToken), readyTimeoutMs);

  return rpcUrl;
}

async function healthCheck(rpcUrl: string, authToken: string): Promise<void> {
  const res = await fetch(new URL("/healthz", rpcUrl), { headers: { authorization: `Bearer ${authToken}` } });
  if (!res.ok) throw new Error(`healthz check against ${rpcUrl} returned ${res.status}`);
}

async function dispatch(rpcUrl: string, authToken: string, exportName: string, input: unknown): Promise<unknown> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await fetch(new URL("/rpc", rpcUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ id, export: exportName, input }),
  });
  const body = (await res.json()) as { id: string; result: unknown } | { id: string; error: string };
  if ("error" in body) throw new Error(body.error);
  return body.result;
}
