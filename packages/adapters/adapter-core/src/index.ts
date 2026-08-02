import type { BerthManifest } from "@berth/manifest-schema";

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
}
