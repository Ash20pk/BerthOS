import { withTimeout, DEPLOY_CREATE_TIMEOUT_MS, DEPLOY_READ_TIMEOUT_MS } from "@berth/adapter-core";
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

  /**
   * Real, confirmed against the installed @daytonaio/sdk@0.202.0 types:
   * sandbox.getPreviewLink(port) returns a real per-port HTTPS preview URL
   * ({url, token}) backed by Daytona's own reverse proxy. The token is only
   * needed for a signed/expiring link (see the SDK's separate
   * getSignedPreviewUrl) — an ordinary preview URL like noVNC's doesn't need
   * it. Throws if the port isn't actually open on the sandbox; the caller
   * treats that as "no preview available" rather than surfacing the error.
   */
  async getPreviewLink(port: number): Promise<string> {
    const link = await withTimeout<any>(this.sandbox.getPreviewLink(port), DEPLOY_READ_TIMEOUT_MS, `daytona getPreviewLink(${port})`);
    return link.url;
  }

  /**
   * Same underlying call as getPreviewLink(), but keeps the `token` a
   * private sandbox's preview link carries instead of discarding it.
   * Confirmed against the installed @daytonaio/sdk@0.202.0's own
   * utils/WebSocket.js, which authenticates a WebSocket connection to a
   * private sandbox's preview URL with exactly
   * `${url}${separator}DAYTONA_SANDBOX_AUTH_KEY=${token}` — appending it the
   * same way here lets a plain HTTP client (no WebSocket, no Daytona SDK)
   * reach a private sandbox's RPC bridge the same way the SDK's own helper
   * would. A non-private sandbox's link has no `token`, so this is a no-op
   * in that case.
   */
  async getAuthenticatedPreviewLink(port: number): Promise<string> {
    const link = await withTimeout<any>(this.sandbox.getPreviewLink(port), DEPLOY_READ_TIMEOUT_MS, `daytona getPreviewLink(${port})`);
    if (!link.token) return link.url;
    const url = new URL(link.url);
    url.searchParams.set("DAYTONA_SANDBOX_AUTH_KEY", link.token);
    return url.toString();
  }

  /**
   * Real, confirmed against the installed @daytonaio/sdk@0.202.0's own type
   * definitions: sandbox.fork({name?}, timeout?) returns a new, independent
   * copy-on-write clone Sandbox instance — a live instance right now,
   * distinct from createSnapshot() below (a reusable template for later).
   * Deliberately calls the stable `fork`, not the deprecated
   * `_experimental_fork` alias the same SDK version also exposes.
   */
  async fork(params?: { name?: string }): Promise<DaytonaDeployHandle> {
    const forked = await withTimeout<any>(
      this.sandbox.fork(params),
      DEPLOY_CREATE_TIMEOUT_MS,
      `daytona fork("${this.id}")`,
    );
    return new DaytonaDeployHandle(forked.id, forked);
  }

  /** Real, confirmed against the same SDK version: sandbox.createSnapshot(name, timeout?) captures the filesystem into a named, reusable template later start()/upload() calls can reference by name. */
  async createSnapshot(name: string): Promise<void> {
    await withTimeout<any>(this.sandbox.createSnapshot(name), DEPLOY_CREATE_TIMEOUT_MS, `daytona createSnapshot("${name}")`);
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
      // Not retried on timeout — same reasoning as adapter-e2b's
      // Template.build: a create-ish call, not cheaply safe to re-attempt
      // blindly on an ambiguous timeout.
      const snapshot = await withTimeout<any>(
        client.snapshot.create({
          name: target.manifest.name,
          image: target.imageRef,
          // Real, confirmed against the installed SDK's own CreateSnapshotParams:
          // regionId pins where this snapshot (and thus every sandbox later
          // started from it) is available. Omitted, Daytona uses the
          // organization's own default region — unchanged from before this
          // field existed.
          ...(target.region ? { regionId: target.region } : {}),
        }),
        DEPLOY_CREATE_TIMEOUT_MS,
        `daytona snapshot.create("${target.manifest.name}")`,
      );
      return { remoteImageRef: snapshot.name ?? target.imageRef };
    },

    async start(remoteImageRef: string, target: DeployTarget) {
      const daytona = await loadDaytona();
      const client = new daytona.Daytona();
      const sandbox = await withTimeout<any>(
        client.create({ snapshot: remoteImageRef, envVars: target.env }),
        DEPLOY_CREATE_TIMEOUT_MS,
        `daytona create("${remoteImageRef}")`,
      );
      return new DaytonaDeployHandle(sandbox.id, sandbox);
    },

    async teardown(handle: DeployHandle) {
      await withTimeout<any>(handle.stop(), DEPLOY_READ_TIMEOUT_MS, `daytona teardown("${handle.id}")`);
    },

    // Daytona.get(sandboxIdOrName) resolves a bare id back into a live
    // Sandbox — used by `berth logs --fleet` to re-attach without starting
    // a new instance.
    async connect(id: string) {
      const daytona = await loadDaytona();
      const client = new daytona.Daytona();
      const sandbox = await withTimeout<any>(client.get(id), DEPLOY_READ_TIMEOUT_MS, `daytona get("${id}")`);
      return new DaytonaDeployHandle(sandbox.id, sandbox);
    },

    // Correct against the real SDK: daytona.list() returns an
    // AsyncIterableIterator<Sandbox> of live instances directly — no
    // separate "connect by id" step needed, unlike adapter-e2b. Not wrapped
    // in withTimeout: it's an async generator, not a single Promise — the
    // per-sandbox iteration below has no single call to bound the same way.
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

    async previewUrl(handle: DeployHandle, port: number) {
      if (!(handle instanceof DaytonaDeployHandle)) return null;
      try {
        return await handle.getPreviewLink(port);
      } catch {
        return null;
      }
    },

    async rpcUrl(handle: DeployHandle, port: number) {
      if (!(handle instanceof DaytonaDeployHandle)) return null;
      try {
        return await handle.getAuthenticatedPreviewLink(port);
      } catch {
        return null;
      }
    },

    async fork(handle: DeployHandle, params?: { name?: string }) {
      if (!(handle instanceof DaytonaDeployHandle)) {
        throw new Error("daytona fork() needs a handle this adapter created");
      }
      return handle.fork(params);
    },

    async snapshot(handle: DeployHandle, name: string) {
      if (!(handle instanceof DaytonaDeployHandle)) {
        throw new Error("daytona snapshot() needs a handle this adapter created");
      }
      await handle.createSnapshot(name);
    },
  };
}
