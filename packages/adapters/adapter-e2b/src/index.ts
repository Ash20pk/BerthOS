import { withTimeout, DEPLOY_CREATE_TIMEOUT_MS, DEPLOY_READ_TIMEOUT_MS } from "@berth/adapter-core";
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
    const running = await withTimeout<any>(
      Promise.resolve(this.sandbox.isRunning?.()),
      DEPLOY_READ_TIMEOUT_MS,
      `e2b sandbox.isRunning("${this.id}")`,
    );
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

  /**
   * Real, confirmed against the installed e2b@1.13.2 SDK's own type
   * definitions: sandbox.getHost(port) returns a real per-port hostname
   * backed by E2B's own HTTPS reverse proxy (e.g. "<port>-<sandboxId>.e2b.dev"),
   * not a raw TCP passthrough. Only meaningful for web-protocol ports (noVNC,
   * ttyd) — see adapter-core's previewUrl doc.
   */
  getHost(port: number): string {
    return this.sandbox.getHost(port);
  }
}

export function createE2bAdapter(): DeployAdapter {
  const adapter: DeployAdapter = {
    name: "e2b",

    async upload(target: DeployTarget) {
      const e2b = await loadE2b();
      // Pushes the locally-built image as an E2B template so start() can
      // reference it by name. Not retried on timeout: a template build is
      // not cheaply idempotent to re-attempt blindly, and this is a create-
      // ish call (see withTimeout's own doc) — the bound here is purely so a
      // truly hung build fails loudly instead of hanging `berth deploy`
      // forever.
      const template = await withTimeout<any>(
        e2b.Template.build({ image: target.imageRef, name: target.manifest.name }),
        DEPLOY_CREATE_TIMEOUT_MS,
        `e2b Template.build("${target.manifest.name}")`,
      );
      return { remoteImageRef: template.templateId ?? target.imageRef };
    },

    async start(remoteImageRef: string, target: DeployTarget) {
      const e2b = await loadE2b();
      const sandbox = await withTimeout<any>(
        e2b.Sandbox.create(remoteImageRef, { envVars: target.env }),
        DEPLOY_CREATE_TIMEOUT_MS,
        `e2b Sandbox.create("${remoteImageRef}")`,
      );
      return new E2bDeployHandle(sandbox.sandboxId ?? sandbox.id, sandbox);
    },

    async teardown(handle: DeployHandle) {
      await withTimeout<any>(handle.stop(), DEPLOY_READ_TIMEOUT_MS, `e2b teardown("${handle.id}")`);
    },

    // Sandbox.connect(id) turns a bare id back into a real instance with
    // working isRunning()/kill()/logs — used both directly (by `berth logs
    // --fleet`) and by list() below.
    async connect(id: string) {
      const e2b = await loadE2b();
      if (typeof e2b.Sandbox?.connect !== "function") {
        throw new Error("this version of the e2b SDK doesn't support Sandbox.connect()");
      }
      const sandbox = await withTimeout<any>(e2b.Sandbox.connect(id), DEPLOY_READ_TIMEOUT_MS, `e2b Sandbox.connect("${id}")`);
      return new E2bDeployHandle(sandbox.sandboxId ?? sandbox.id, sandbox);
    },

    // `Sandbox.list()` (confirmed against the actual installed e2b SDK's
    // type definitions, v1.13.2) returns plain ListedSandbox summaries —
    // {sandboxId, state, ...} — not live instances with isRunning()/kill()/
    // logs, hence reconnecting each one via connect() above.
    async list() {
      const e2b = await loadE2b();
      if (typeof e2b.Sandbox?.list !== "function" || typeof e2b.Sandbox?.connect !== "function") return [];
      const summaries = await withTimeout<any>(e2b.Sandbox.list(), DEPLOY_READ_TIMEOUT_MS, "e2b Sandbox.list()");
      return Promise.all((summaries ?? []).map((s: any) => adapter.connect!(s.sandboxId ?? s.id)));
    },

    async previewUrl(handle: DeployHandle, port: number) {
      if (!(handle instanceof E2bDeployHandle)) return null;
      const host = handle.getHost(port);
      return host ? `https://${host}` : null;
    },

    // Same reverse-proxy mechanism previewUrl() uses — E2B's getHost(port)
    // needs no separate query-param/token handling the way Daytona's does,
    // since bootNetworkedAgent({fleet})'s own bearer token (sent as a header
    // by the HTTP RPC client) is the only auth layer here.
    async rpcUrl(handle: DeployHandle, port: number) {
      if (!(handle instanceof E2bDeployHandle)) return null;
      const host = handle.getHost(port);
      return host ? `https://${host}` : null;
    },
  };
  return adapter;
}
