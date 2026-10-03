import { existsSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SHARP_HOOK_URL } from "./sharp-hook.js";

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
// "Its own location" differs by build: dist/semantic-fs/embeddings.js here,
// but the package root itself in the external build, where esbuild bundles
// this module into index.js and runtime.js. So the directory is found by
// walking up to the nearest package.json, the SDK's own, rather than by a
// fixed number of "..".
const MODEL_CACHE_DIR = join(packageRoot(dirname(fileURLToPath(import.meta.url))), "models");

function packageRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dirname(dir) === dir) return from;
  }
}

// Lazily imported: pulling in @xenova/transformers (and its WASM ONNX
// runtime) at module load time would pay that cost even for apps that never
// call tag()/query(), and every resident app process imports this module
// transitively via runtime.ts.
type Pipeline = (text: string, options: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array }>;
let pipelinePromise: Promise<Pipeline> | undefined;

/**
 * Points @xenova/transformers' `import "sharp"` at the SDK's own stub before
 * it loads (see sharp-hook.ts). Once per process; module.register() applies
 * to every later import on this thread, which is why the hook only redirects
 * imports made from inside @xenova/transformers.
 */
let sharpStubRegistered = false;
export function registerSharpStub(): void {
  if (sharpStubRegistered) return;
  register(SHARP_HOOK_URL);
  sharpStubRegistered = true;
}

/**
 * A prebuilt kit, when the sandbox has one: a microVM's rootfs carries
 * @xenova/transformers bundled into one ES module, its WASM runtime and the
 * model, at the directory berth-init names in BERTH_EMBEDDINGS_DIR
 * (packages/vmm/scripts/bundle-embeddings.mjs). An app's own bundle can't
 * run transformers: its CommonJS parts need __filename, and the model isn't
 * in the app's share.
 */
type Transformers = typeof import("@xenova/transformers");
async function loadTransformers(): Promise<{ transformers: Transformers; models: string; wasm?: string }> {
  const kit = process.env.BERTH_EMBEDDINGS_DIR;
  if (kit) {
    const transformers = (await import(pathToFileURL(join(kit, "transformers.mjs")).href)) as Transformers;
    return { transformers, models: join(kit, "models"), wasm: `${kit}/` };
  }
  registerSharpStub();
  return { transformers: await import("@xenova/transformers"), models: MODEL_CACHE_DIR };
}

async function loadPipeline(): Promise<Pipeline> {
  const { transformers, models, wasm } = await loadTransformers();
  const { pipeline, env } = transformers;
  env.allowRemoteModels = false; // fail closed if the cache is missing, rather than reaching out to the Hub
  // Two separate config properties, confirmed the hard way: `cacheDir` only
  // governs where a *remote-fetched* file gets cached — with
  // allowRemoteModels=false, the actual read path is `localModelPath` (see
  // @xenova/transformers/src/utils/hub.js's `localPath = pathJoin(env.localModelPath, requestURL)`,
  // checked before remote is ever considered). Both point at the same
  // directory here since the prefetch step and this runtime lookup need to agree.
  env.cacheDir = models;
  env.localModelPath = models;
  if (wasm) env.backends.onnx.wasm.wasmPaths = wasm;
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

/**
 * The sandbox's shared embedding daemon, when it has one: a microVM's
 * berth-init runs one per sandbox (packages/vmm/guest/embeddings-daemon.mjs),
 * because the model costs each process that loads it about 200 MB. One JSON
 * line each way per request; a connection per call keeps it simple.
 */
function viaDaemon(socketPath: string, request: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = "";
    const timer = setTimeout(() => (sock.destroy(), reject(new Error(`no answer from the embedding daemon in ${timeoutMs} ms`))), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify({ id: "1", ...request })}\n`));
    sock.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      clearTimeout(timer);
      sock.end();
      try {
        resolve(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
      } catch {
        reject(new Error("the embedding daemon's answer is not JSON"));
      }
    });
    sock.on("error", (err) => (clearTimeout(timer), reject(err)));
  });
}

/** Fire-and-forget: starts the WASM/model load in the background so it's likely warm before the app's first real tag()/query() call. */
export function warmup(): void {
  const socketPath = process.env.BERTH_EMBEDDINGS_SOCKET;
  const loading = socketPath
    ? viaDaemon(socketPath, { op: "warmup" }).then((r) => {
        if (r.ok !== true) throw new Error(String(r.error ?? "warmup refused"));
      })
    : getPipeline();
  void loading.catch((err) => {
    console.error(`[semantic-fs:embeddings] warmup failed (will retry on next call): ${err}`);
  });
}

/** Best-effort: returns undefined (never throws) on any failure — callers fall back to keyword-only ranking. */
export async function embedText(text: string): Promise<number[] | undefined> {
  try {
    const socketPath = process.env.BERTH_EMBEDDINGS_SOCKET;
    if (socketPath) {
      const r = await viaDaemon(socketPath, { text });
      if (!Array.isArray(r.embedding)) throw new Error(String(r.error ?? "no embedding in the answer"));
      return r.embedding as number[];
    }
    const extractor = await getPipeline();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  } catch (err) {
    console.error(`[semantic-fs:embeddings] embedText failed, falling back to keyword-only ranking: ${err}`);
    return undefined;
  }
}
