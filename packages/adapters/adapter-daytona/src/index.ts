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
    private workspace: any,
  ) {}

  async status(): Promise<DeployStatus> {
    const state = await this.workspace.info?.();
    return state?.state === "started" ? "running" : "stopped";
  }

  async *streamLogs(): AsyncIterable<string> {
    if (typeof this.workspace.logs?.[Symbol.asyncIterator] === "function") {
      for await (const line of this.workspace.logs as AsyncIterable<string>) {
        yield String(line);
      }
    }
  }

  async stop(): Promise<void> {
    await this.workspace.stop();
  }
}

export function createDaytonaAdapter(): DeployAdapter {
  return {
    name: "daytona",

    async upload(target: DeployTarget) {
      const daytona = await loadDaytona();
      const client = new daytona.Daytona();
      // Registers the locally-built image so start() can create a workspace from it.
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
  };
}
