/**
 * Phase 4's semantic filesystem client — the counterpart to
 * ContextBusClient (../context-bus/client.ts) for Berth's other userspace
 * primitive. Resident apps write ordinary files under BERTH_CONTEXT_MOUNT
 * (default /context, see @berth/docker-orchestrator's entrypoint.sh, which
 * mounts the semantic-fs-daemon's FUSE filesystem there before this runtime
 * boots) and use this client to register their identity (so writes are
 * attributed via created_by), attach task/related_apps metadata, and query
 * by intent.
 */
export interface SemanticFsQueryResult {
  path: string;
  createdBy?: string;
  task?: string;
  relatedApps?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface SemanticFsClient {
  /** Associates this process's pid with an app name, so subsequent writes through /context are attributed to it. */
  register(info: { app: string }): Promise<void>;
  /** Attaches task/related_apps metadata to a path already written under /context (relative to the mount root). */
  tag(path: string, meta: { task?: string; relatedApps?: string[] }): Promise<void>;
  /** Keyword query over path/created_by/task/related_apps metadata — see semantic-fs-daemon's index.Query for ranking semantics. */
  query(text: string, limit?: number): Promise<SemanticFsQueryResult[]>;
}
