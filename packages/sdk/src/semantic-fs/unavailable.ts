import type { SemanticFsClient, SemanticFsQueryResult } from "./client.js";

/**
 * What an app gets when it is running *inside* a Berth sandbox and the
 * semantic-fs daemon is not reachable — as opposed to running outside one,
 * where `createLocalSemanticFs()` remains the right answer.
 *
 * The distinction is the whole point of this file. The local stub returns an
 * empty result set from `query()`, which is correct when there is genuinely no
 * index to search (a bare `node dist/index.js` in a unit test). Inside a
 * sandbox the index exists and the daemon is meant to be serving it, so an
 * empty result set is not an answer — it is a wrong answer, indistinguishable
 * from "nothing matched". Retrieval, checkpoints, sessions and traces all read
 * through here, so the failure mode was silent data loss reported as success
 * (REMEDIATION.md 1.14).
 *
 * `tag()` throws for the same reason: a tag that appears to succeed while
 * nothing was stored is a lost write.
 *
 * `register()` deliberately does not throw. It runs at boot, before the app
 * has done anything, and taking the whole app down because attribution is
 * unavailable would be a worse outcome than the app running with its /context
 * writes unattributed — which is what happens, loudly, once per boot. Every
 * *later* call still throws, so nothing silently reads or writes through a
 * daemon that isn't there.
 */
export function createUnavailableSemanticFs(socketPath: string, reason: string): SemanticFsClient {
  const detail = `semantic-fs daemon is not reachable at ${socketPath} (${reason})`;

  return {
    async register(info) {
      console.error(
        `[berth:runtime] WARNING: ${detail} — this app is running inside a sandbox, so this is a fault, not a local-dev fallback. ` +
          `"${info.app}" will not be attributed as the author of anything it writes under /context, and every tag()/query() call will throw until the daemon is back.`,
      );
    },
    async tag(path) {
      throw new Error(`cannot tag "${path}": ${detail}. Nothing was stored — treating this as a lost write rather than reporting success.`);
    },
    async query(text): Promise<SemanticFsQueryResult[]> {
      throw new Error(
        `cannot query "${text}": ${detail}. Returning an empty result set here would be indistinguishable from "nothing matched", which is why this throws instead.`,
      );
    },
  };
}
