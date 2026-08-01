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

    // Verified against the actually-installed @daytonaio/sdk (v0.202.0):
    // `Daytona` has no `.image`/`.workspace` — only `.snapshot`
    // (SnapshotService) plus create()/get()/list()/stop() operating on a
    // "Sandbox" concept. A snapshot is the stable, reusable ref `start()`
    // needs (deploy.ts calls upload() once and reuses its remoteImageRef
    // across multiple start() calls for --count > 1), so upload() registers
    // one here rather than creating a sandbox directly.
    async upload(target: DeployTarget) {
      const daytona = await loadDaytona();
      const client = new daytona.Daytona();
      // NOTE: target.imageRef is a local Docker tag (see DeployTarget) —
      // SnapshotService.create()'s `image` param expects a
      // registry-resolvable reference. This mirrors the same assumption
      // the prior code made; pushing to a registry first is a separate,
      // larger fix and out of scope here.
      const snapshot = await client.snapshot.create({
        name: target.manifest.name,
        image: target.imageRef,
      });
      return { remoteImageRef: snapshot.name ?? target.imageRef };
    },

    async start(remoteImageRef: string, target: DeployTarget) {
      const daytona = await loadDaytona();
      const client = new daytona.Daytona();
      const sandbox = await client.create({
        snapshot: remoteImageRef,
        envVars: target.env,
      });
      return new DaytonaDeployHandle(sandbox.id, sandbox);
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
