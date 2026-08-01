import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Compute-on-tag, not compute-on-write: write_context_file (apps/filesystem)
// does a raw fs write into the FUSE mount, never touching this SDK — the
// daemon observes it passively. tag()/query() are the only control-plane
// calls that reach JS, so embeddings are computed from tag()'s
// task/relatedApps/path text and from query()'s text, not file content.
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

// Baked in at `pnpm install` time by scripts/prefetch-embedding-model.mjs —
// the one point in the build/deploy pipeline with guaranteed network access
// (production images are staged via `pnpm deploy` on the host before the
// Docker build context even exists; containers have no guaranteed runtime
// internet). Resolved from this file's own location, not process.cwd() —
// the caller's cwd is the *resident app's* directory, not this package's.
const MODEL_CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "models");

// Lazily imported: pulling in @xenova/transformers (and its WASM ONNX
// runtime) at module load time would pay that cost even for apps that never
// call tag()/query(), and every resident app process imports this module
// transitively via runtime.ts.
type Pipeline = (text: string, options: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array }>;
let pipelinePromise: Promise<Pipeline> | undefined;

async function loadPipeline(): Promise<Pipeline> {
  const { pipeline, env } = await import("@xenova/transformers");
  env.allowRemoteModels = false; // fail closed if the cache is missing, rather than reaching out to the Hub
  // Two separate config properties, confirmed the hard way: `cacheDir` only
  // governs where a *remote-fetched* file gets cached — with
  // allowRemoteModels=false, the actual read path is `localModelPath` (see
  // @xenova/transformers/src/utils/hub.js's `localPath = pathJoin(env.localModelPath, requestURL)`,
  // checked before remote is ever considered). Both point at the same
  // directory here since the prefetch step and this runtime lookup need to agree.
  env.cacheDir = MODEL_CACHE_DIR;
  env.localModelPath = MODEL_CACHE_DIR;
  // onnxruntime-web's multi-threaded WASM path spawns a Worker from a blob:
  // URL, which Node's worker_threads doesn't support (`ERR_WORKER_PATH`) —
  // confirmed by hand to hang indefinitely rather than error, under plain
  // Node. Forcing single-threaded WASM avoids that path entirely.
  env.backends.onnx.wasm.numThreads = 1;
  return (await pipeline("feature-extraction", EMBEDDING_MODEL, { quantized: true })) as unknown as Pipeline;
}

function getPipeline(): Promise<Pipeline> {
  pipelinePromise ??= loadPipeline().catch((err) => {
    pipelinePromise = undefined; // allow a later call to retry rather than caching a permanent failure
    throw err;
  });
  return pipelinePromise;
}

/** Fire-and-forget: starts the WASM/model load in the background so it's likely warm before the app's first real tag()/query() call. */
export function warmup(): void {
  void getPipeline().catch((err) => {
    console.error(`[semantic-fs:embeddings] warmup failed (will retry on next call): ${err}`);
  });
}

/** Best-effort: returns undefined (never throws) on any failure — callers fall back to keyword-only ranking. */
export async function embedText(text: string): Promise<number[] | undefined> {
  try {
    const extractor = await getPipeline();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  } catch (err) {
    console.error(`[semantic-fs:embeddings] embedText failed, falling back to keyword-only ranking: ${err}`);
    return undefined;
  }
}
