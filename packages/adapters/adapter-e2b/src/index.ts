import type { DeployAdapter, DeployHandle, DeployStatus, DeployTarget } from "@berth/adapter-core";

/**
 * `e2b` is an optional peer dependency: `berth deploy --fleet=e2b` only needs
 * it installed if you actually deploy to E2B. It's imported dynamically (and
 * typed loosely) so the rest of the framework builds and tests without it
 * present — see adapter-core's DeployAdapter for the contract this satisfies.
 */
async function loadE2b(): Promise<any> {
  try {
    return await import("e2b");
  } catch {
    throw new Error(
      '@berth/adapter-e2b requires the "e2b" package. Install it with `pnpm add e2b` to deploy to E2B.',
    );
  }
}

class E2bDeployHandle implements DeployHandle {
  constructor(
    public id: string,
    private sandbox: any,
  ) {}

  async status(): Promise<DeployStatus> {
    const running = await this.sandbox.isRunning?.();
    return running ? "running" : "stopped";
  }

  async *streamLogs(): AsyncIterable<string> {
    // E2B's log-streaming API varies by SDK version; this wraps whatever
    // async-iterable/callback form is available into our shared shape.
    if (typeof this.sandbox.logs?.[Symbol.asyncIterator] === "function") {
      for await (const line of this.sandbox.logs as AsyncIterable<string>) {
        yield String(line);
      }
    }
  }

  async stop(): Promise<void> {
    await this.sandbox.kill();
  }
}

export function createE2bAdapter(): DeployAdapter {
  const adapter: DeployAdapter = {
    name: "e2b",

    async upload(target: DeployTarget) {
      const e2b = await loadE2b();
      // Pushes the locally-built image as an E2B template so start() can
      // reference it by name.
      const template = await e2b.Template.build({
        image: target.imageRef,
        name: target.manifest.name,
      });
      return { remoteImageRef: template.templateId ?? target.imageRef };
    },

    async start(remoteImageRef: string, target: DeployTarget) {
      const e2b = await loadE2b();
      const sandbox = await e2b.Sandbox.create(remoteImageRef, {
        envVars: target.env,
      });
      return new E2bDeployHandle(sandbox.sandboxId ?? sandbox.id, sandbox);
    },

    async teardown(handle: DeployHandle) {
      await handle.stop();
    },

    // Sandbox.connect(id) turns a bare id back into a real instance with
    // working isRunning()/kill()/logs — used both directly (by `berth logs
    // --fleet`) and by list() below.
    async connect(id: string) {
      const e2b = await loadE2b();
      if (typeof e2b.Sandbox?.connect !== "function") {
        throw new Error("this version of the e2b SDK doesn't support Sandbox.connect()");
      }
      const sandbox = await e2b.Sandbox.connect(id);
      return new E2bDeployHandle(sandbox.sandboxId ?? sandbox.id, sandbox);
    },

    // `Sandbox.list()` (confirmed against the actual installed e2b SDK's
    // type definitions, v1.13.2) returns plain ListedSandbox summaries —
    // {sandboxId, state, ...} — not live instances with isRunning()/kill()/
    // logs, hence reconnecting each one via connect() above.
    async list() {
      const e2b = await loadE2b();
      if (typeof e2b.Sandbox?.list !== "function" || typeof e2b.Sandbox?.connect !== "function") return [];
      const summaries = await e2b.Sandbox.list();
      return Promise.all((summaries ?? []).map((s: any) => adapter.connect!(s.sandboxId ?? s.id)));
    },
  };
  return adapter;
}
