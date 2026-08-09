/**
 * Phase 4's semantic filesystem client — the counterpart to
 * ContextBusClient (../context-bus/client.ts) for Berth's other userspace
 * primitive. Resident apps write ordinary files under BERTH_CONTEXT_MOUNT
 * (default /context, see @berth/docker-orchestrator's entrypoint.sh, which
 * mounts the semantic-fs-daemon's FUSE filesystem there before this runtime
 * boots) and use this client to register their identity (so writes are
 * attributed via created_by), attach task/related_apps metadata, and search
 * over that metadata.
 *
 * "Search" here is a hybrid keyword + embedding ranker over *tag text* —
 * task, relatedApps, path, created_by — not over file content, and not over
 * files nothing ever tagged. See query()'s doc comment below and
 * docs/semantic-fs-reference.md for the ranking and its scaling limit.
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
  /**
   * Hybrid keyword + embedding-similarity search over the *tag text* of files
   * that were explicitly tagged (path/created_by/task/relatedApps), never over
   * file content. Keyword hits are whole integers and cosine similarity is in
   * [0,1], so a single substring hit outranks a perfect semantic match. See
   * semantic-fs-daemon's index.Query for the exact ranking.
   */
  query(text: string, limit?: number): Promise<SemanticFsQueryResult[]>;
}
