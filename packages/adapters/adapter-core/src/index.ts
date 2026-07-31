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
}
