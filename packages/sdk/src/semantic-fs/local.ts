import type { SemanticFsClient, SemanticFsQueryResult } from "./client.js";

/**
 * Stand-in for apps run outside a sandbox (e.g. a bare `node dist/index.js`
 * during a unit test), where no semantic-fs-daemon is mounted at
 * /context — mirrors ../context-bus/local.ts's role for the context bus.
 * Query always returns empty rather than erroring, since there's no index to
 * search.
 */
export function createLocalSemanticFs(): SemanticFsClient {
  return {
    async register(info) {
      console.debug(`[semantic-fs:local] register app="${info.app}" (no-op — no daemon mounted)`);
    },
    async tag(path, meta) {
      console.debug(`[semantic-fs:local] tag path="${path}"`, meta);
    },
    async query(text): Promise<SemanticFsQueryResult[]> {
      console.debug(`[semantic-fs:local] query="${text}" -> [] (no index outside a sandbox)`);
      return [];
    },
  };
}
