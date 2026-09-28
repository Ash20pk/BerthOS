/**
 * The sandbox behind one `berth mcp` session, brought up in the background
 * while the bridge already answers `initialize`. Pulled out of
 * commands/mcp.ts so the states it goes through can be tested without
 * Docker: the Docker work is behind `SandboxSteps`.
 *
 * What this has to get right:
 *
 *  - Ownership starts when this session decides to boot, not when the boot
 *    finishes. The container's name is fixed before anything is created, so
 *    a client that leaves mid-boot (a first boot builds an image and can take
 *    minutes) gets the container, and its semantic-fs sidecar, stopped by
 *    name. It used to be stopped only once the boot had handed the container
 *    back, after a wait of up to 60 s that MCP clients don't give: they send
 *    SIGTERM, then SIGKILL, within seconds of closing the pipe.
 *  - Stopping doesn't wait for the boot. The boot is told to stop (checked
 *    between its steps), what exists is stopped by name straight away, and it
 *    is stopped by name once more if the boot settles shortly afterwards.
 *  - Any failure after the decision to boot cleans up, not only a runtime
 *    that never reported ready: a boot that failed after creating the
 *    container or sidecar, or an RPC attach that failed after the boot.
 *  - A tool call waits for the sandbox for a bounded time, and not at all
 *    once its client has cancelled it.
 */

export interface SandboxSteps<C, S> {
  /** The session's container if one is already running under its name. */
  find(): Promise<C | undefined>;
  /** Builds the image and starts the container. `signal` aborts when the session ends. */
  boot(signal: AbortSignal): Promise<C>;
  /** Resolves once the app's runtime reports ready. */
  waitReady(container: C, signal: AbortSignal): Promise<void>;
  /** Everything after the container is up: reading enforcement, attaching RPC. */
  connect(container: C, bootedHere: boolean): Promise<S>;
  /** Stops and removes the container with the session's name and its sidecar, whether or not boot() has returned it. Must not throw. */
  stopByName(): Promise<void>;
}

export interface BackgroundSandboxOptions {
  /** False for --no-boot: attach to a running container or fail. */
  allowBoot: boolean;
  /** The error when there is nothing to attach to and booting isn't allowed. */
  noBootMessage: string;
  /** After stopping by name mid-boot, how long to wait for the boot to settle before stopping by name once more. */
  settleMs?: number;
}

export type SandboxState = "starting" | "ready" | "failed" | "stopped";

export interface BackgroundSandbox<S> {
  /** Resolves with the connected sandbox; rejects with why it didn't start. */
  readonly ready: Promise<S & { bootedHere: boolean }>;
  state(): SandboxState;
  /** True once this session has decided to boot the container, and so owns it. */
  owns(): boolean;
  /**
   * For a tool call: the sandbox once it is ready, waiting at most `waitMs`,
   * and giving up as soon as `signal` aborts (the client cancelled the call).
   */
  whenReady(options: { waitMs: number; signal?: AbortSignal }): Promise<S & { bootedHere: boolean }>;
  /** Tells a boot in progress to stop, and stops what this session owns. Idempotent. */
  stop(): Promise<void>;
}

export class SandboxNotReadyError extends Error {}

/** Docker's answer when a container name is already taken: someone else made it, so it isn't ours to stop. */
function isNameConflict(err: unknown): boolean {
  return (err as { statusCode?: number } | null)?.statusCode === 409;
}

export function startBackgroundSandbox<C, S>(steps: SandboxSteps<C, S>, options: BackgroundSandboxOptions): BackgroundSandbox<S> {
  const settleMs = options.settleMs ?? 3_000;
  const abort = new AbortController();
  let owns = false;
  let state: SandboxState = "starting";

  const stopped = () => {
    if (abort.signal.aborted) throw new SandboxNotReadyError("the session ended before the sandbox finished starting");
  };

  const ready = (async () => {
    const found = await steps.find();
    stopped();
    if (found) return { ...(await steps.connect(found, false)), bootedHere: false };
    if (!options.allowBoot) throw new Error(options.noBootMessage);

    owns = true;
    try {
      const container = await steps.boot(abort.signal);
      stopped();
      await steps.waitReady(container, abort.signal);
      stopped();
      const connected = await steps.connect(container, true);
      stopped();
      return { ...connected, bootedHere: true };
    } catch (err) {
      if (isNameConflict(err)) owns = false;
      else await steps.stopByName();
      throw err;
    }
  })();
  ready.then(
    () => {
      if (state === "starting") state = "ready";
    },
    () => {
      if (state === "starting") state = "failed";
    },
  );

  let stopping: Promise<void> | undefined;
  return {
    ready,
    state: () => state,
    owns: () => owns,
    whenReady({ waitMs, signal }) {
      if (signal?.aborted) return Promise.reject(new SandboxNotReadyError("the client cancelled the call"));
      return new Promise<S & { bootedHere: boolean }>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          done();
          reject(new SandboxNotReadyError("the client cancelled the call while the sandbox was starting"));
        };
        const timer = setTimeout(() => {
          done();
          reject(new SandboxNotReadyError(`the sandbox is still starting after ${Math.round(waitMs / 1000)}s (a first boot builds its image) — try the call again shortly`));
        }, waitMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        ready.then(
          (sandbox) => {
            done();
            resolve(sandbox);
          },
          (err: unknown) => {
            done();
            reject(err);
          },
        );
      });
    },
    stop() {
      stopping ??= (async () => {
        const wasStarting = state === "starting";
        abort.abort();
        state = "stopped";
        if (!owns) return;
        await steps.stopByName();
        if (wasStarting) {
          // Anything the boot creates after the first stop (the container
          // right after its image finished building) is caught here.
          await settle(ready, settleMs);
          await steps.stopByName();
        }
      })();
      return stopping;
    },
  };
}

function settle(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise.then(() => undefined, () => undefined), new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]).finally(() =>
    clearTimeout(timer),
  );
}
