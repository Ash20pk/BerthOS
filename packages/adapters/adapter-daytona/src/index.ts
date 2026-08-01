import type { DeployAdapter, DeployHandle, DeployStatus, DeployTarget } from "@berth/adapter-core";

/**
 * `@daytonaio/sdk` is an optional peer dependency, mirroring adapter-e2b:
 * `berth deploy --fleet=daytona` only needs it installed if you actually
 * deploy to Daytona.
 */
async function loadDaytona(): Promise<any> {
  try {
    return await import("@daytonaio/sdk");
  } catch {
    throw new Error(
      '@berth/adapter-daytona requires the "@daytonaio/sdk" package. Install it with `pnpm add @daytonaio/sdk` to deploy to Daytona.',
    );
  }
}

class DaytonaDeployHandle implements DeployHandle {
  constructor(
    public id: string,
    private sandbox: any,
  ) {}

  async status(): Promise<DeployStatus> {
    return this.sandbox.state === "started" ? "running" : "stopped";
  }

  // No log-stream API exists on Sandbox/Daytona in the currently-installed
  // SDK (v0.202.0) — the only logs hook is a snapshot-creation callback,
  // unrelated to a running sandbox's own stdout/stderr. Yields nothing
  // rather than guessing at a property that isn't there.
  async *streamLogs(): AsyncIterable<string> {}

  async stop(): Promise<void> {
    await this.sandbox.stop();
  }
}

export function createDaytonaAdapter(): DeployAdapter {
  return {
    name: "daytona",

    // NOTE: verified against the actually-installed @daytonaio/sdk
    // (v0.202.0, present in this repo's node_modules) that `client.image`
    // and `client.workspace` DO NOT EXIST on the real `Daytona` class — this
    // SDK version only exposes `daytona.create()`/`.get()`/`.list()`/
    // `.stop()` operating on a "Sandbox" concept, not "workspace". upload()
    // and start() below predate that shape and will throw
    // "Cannot read properties of undefined" at runtime as written. Left
    // as-is here — rewriting them is a bigger fix than this pass's actual
    // scope (adding list() for `berth fleet status`) — but flagged clearly
    // rather than silently compounding the mismatch into list() too, which
    // (along with DaytonaDeployHandle above) has been corrected to match
    // the real SDK.
    async upload(target: DeployTarget) {
      const daytona = await loadDaytona();
      const client = new daytona.Daytona();
      const image = await client.image.register(target.imageRef, { name: target.manifest.name });
      return { remoteImageRef: image.ref ?? target.imageRef };
    },

    async start(remoteImageRef: string, target: DeployTarget) {
      const daytona = await loadDaytona();
      const client = new daytona.Daytona();
      const workspace = await client.workspace.create({
        image: remoteImageRef,
        envVars: target.env,
      });
      return new DaytonaDeployHandle(workspace.id, workspace);
    },

    async teardown(handle: DeployHandle) {
      await handle.stop();
    },

    // Correct against the real SDK: daytona.list() returns an
    // AsyncIterableIterator<Sandbox> of live instances directly — no
    // separate "connect by id" step needed, unlike adapter-e2b.
    async list() {
      const daytona = await loadDaytona();
      const client = new daytona.Daytona();
      if (typeof client.list !== "function") return [];
      const handles: DeployHandle[] = [];
      for await (const sandbox of client.list() as AsyncIterable<any>) {
        handles.push(new DaytonaDeployHandle(sandbox.id, sandbox));
      }
      return handles;
    },
  };
}
