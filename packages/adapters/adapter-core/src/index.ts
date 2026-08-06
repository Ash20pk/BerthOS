import type { BerthManifest } from "@berth/manifest-schema";

/**
 * Every deploy adapter's SDK calls are real network requests against a
 * third-party provider (E2B, Daytona, a Kubernetes API server) with no
 * bound of their own — a single hung request (provider outage, a dropped
 * connection the SDK's own client never notices) previously blocked
 * `berth deploy` forever with zero feedback. This wraps any such call with a
 * hard deadline: on timeout, the original promise is left to settle on its
 * own (there's no cross-SDK-safe way to cancel an arbitrary in-flight
 * request), but the caller gets a clear, actionable error back immediately
 * instead of hanging.
 *
 * Deliberately NOT bundled with a retry: retrying a create-ish call (start a
 * sandbox, build a template, create a Pod) after an ambiguous timeout risks
 * creating a duplicate resource if the original request actually succeeded
 * server-side but the response never arrived — worse than the hang it would
 * "fix." A read-ish call (status, list, connect) is safe to retry and a
 * caller may choose to wrap withTimeout() in its own retry loop; this
 * utility only ever bounds the wait.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
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

/** Generous — a template/image build or a sandbox/Pod boot can legitimately take minutes, not seconds. */
export const DEPLOY_CREATE_TIMEOUT_MS = 5 * 60 * 1000;
/** A status/list/connect call is a plain read against the provider's API — if it hasn't answered in 30s, something is genuinely wrong, not just slow. */
export const DEPLOY_READ_TIMEOUT_MS = 30 * 1000;

export interface DeployTarget {
  /** Local docker image tag, e.g. "berth/github-assistant:1.0.0". */
  imageRef: string;
  manifest: BerthManifest;
  env?: Record<string, string>;
}

export type DeployStatus = "starting" | "running" | "stopped" | "error";

export interface DeployHandle {
  /** Adapter-specific instance/sandbox id. */
  id: string;
  status(): Promise<DeployStatus>;
  streamLogs(): AsyncIterable<string>;
  stop(): Promise<void>;
}

/**
 * Every deploy provider (E2B, Daytona, and whatever Phase 3 adds later)
 * implements this same shape. `cli`'s deploy command only ever imports this
 * interface plus a name->adapter lookup — never a provider SDK directly —
 * so adding a new backend means writing one adapter package, not touching
 * the CLI.
 */
export interface DeployAdapter {
  readonly name: string;
  upload(target: DeployTarget): Promise<{ remoteImageRef: string }>;
  start(remoteImageRef: string, target: DeployTarget): Promise<DeployHandle>;
  teardown(handle: DeployHandle): Promise<void>;
  /**
   * Lists instances currently running on this provider, if it exposes such
   * an API — optional because "list everything running" isn't guaranteed by
   * every backend's SDK the same way upload/start/teardown are. Adapters
   * that can't support it simply omit this method; callers (e.g. `berth
   * fleet status`) fall back to locally-persisted state instead.
   */
  list?(): Promise<DeployHandle[]>;
  /**
   * Reconnects to a specific already-running instance by id, if this
   * provider's SDK supports resolving one directly — optional for the same
   * reason list() is. Used by `berth logs --fleet` to re-attach to a
   * previously-started remote instance without starting a new one.
   */
  connect?(id: string): Promise<DeployHandle>;
  /**
   * A reachable URL for a port on this instance, if the provider exposes one
   * — optional because not every provider/handle combination supports it
   * (or a sandbox may not be far enough along in its boot for one to exist
   * yet). `null` means "this provider supports the method, but no URL is
   * available for this instance/port right now," distinct from the method
   * being entirely absent. Only ever called when the app itself opted in via
   * berth.yml's `expose.preview: true` — see docs/manifest-reference.md and
   * docs/shipping-to-production.md. Scoped to web-protocol ports (noVNC,
   * ttyd) that can actually ride each provider's own port-exposure mechanism;
   * raw VNC/CDP have no equivalent and stay local-only regardless.
   */
  previewUrl?(handle: DeployHandle, port: number): Promise<string | null>;
  /**
   * A reachable URL for this instance's HTTP RPC bridge (see @berth/sdk's
   * startHttpRpcServer / BERTH_HTTP_RPC_PORT), used by @berth/agents's
   * bootNetworkedAgent({fleet}) to dispatch tool calls to a peer deployed to
   * this provider instead of a local Docker container. Deliberately
   * separate from previewUrl(): that one is a human-facing, opt-in-via-
   * berth.yml capability (noVNC/ttyd); this one is only ever requested when
   * bootNetworkedAgent({fleet}) itself deployed through this adapter, and
   * the URL it returns is meant to carry its own bearer-token auth (see each
   * adapter's implementation) rather than being a bare, unauthenticated
   * endpoint. `null` means the same thing previewUrl()'s null does:
   * supported in principle, not available for this instance/port right now.
   */
  rpcUrl?(handle: DeployHandle, port: number): Promise<string | null>;
  /**
   * Pauses a running instance in place — a full memory+filesystem capture
   * that resume(handle.id) can bring back later, without a fresh
   * upload()/start() (which would boot clean, losing all in-sandbox state).
   * Optional: only a provider with a native pause primitive implements this
   * — of the adapters shipped today, that's E2B, not Daytona or k8s (a Pod
   * has no equivalent without cluster-level CRIU tooling this project
   * doesn't set up). See docs/manifest-reference.md's sibling docs and
   * gaps.md gap #29 for exactly which adapter supports what.
   */
  pause?(handle: DeployHandle): Promise<void>;
  /**
   * Resumes a previously pause()d instance by id, returning a fresh handle
   * to the same instance (same id, its paused state restored) rather than a
   * new one. Optional for the same reason pause() is — implement both or
   * neither.
   */
  resume?(id: string): Promise<DeployHandle>;
  /**
   * Forks a running instance into a new, independent copy-on-write clone —
   * a live instance right now, distinct from snapshot() below (a reusable
   * template for a *later* start()). Optional: of the adapters shipped
   * today, only Daytona has this as a native primitive.
   */
  fork?(handle: DeployHandle, params?: { name?: string }): Promise<DeployHandle>;
  /**
   * Captures a running instance's filesystem into a named, reusable
   * template/image this provider can start() new instances from later —
   * this provider's own equivalent of docker-orchestrator's local
   * createSnapshot(), for providers where "snapshot" means "a new template,"
   * not "a paused copy of this exact instance" (that's pause()/resume()
   * above). Optional: of the adapters shipped today, only Daytona has this.
   */
  snapshot?(handle: DeployHandle, name: string): Promise<void>;
}
