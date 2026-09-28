#!/usr/bin/env node
// Runs at `pnpm install` time (this package's postinstall) — the one point
// in the build/deploy pipeline with guaranteed network access. Production
// images are staged via `pnpm deploy` on the HOST before the Docker build
// context is even created, and containers have no guaranteed runtime
// internet — so model weights must be baked in now, not fetched lazily at
// container boot. See src/semantic-fs/embeddings.ts for the runtime side
// (env.allowRemoteModels = false there fails closed if this step is
// skipped, rather than silently reaching out to the Hub from inside a
// sandbox).
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

const MODEL_CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "models");

// The published package already carries the model, so an npm install has
// nothing to fetch.
const MODEL_FILE = join(MODEL_CACHE_DIR, "Xenova", "all-MiniLM-L6-v2", "onnx", "model_quantized.onnx");
if (existsSync(MODEL_FILE)) {
  console.log(`[prefetch-embedding-model] model already present in ${MODEL_CACHE_DIR}`);
  process.exit(0);
}

// @xenova/transformers won't load without sharp, whose native build isn't
// available here. The SDK answers `import "sharp"` with a stub at runtime
// (src/semantic-fs/sharp-hook.ts); this runs during install, before dist/
// exists, so it registers the same hook inline.
const SHARP_STUB = "data:text/javascript,export default function sharp() { throw new Error('sharp is stubbed out'); }";
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(specifier, context, next) { return specifier === "sharp" ? { url: ${JSON.stringify(SHARP_STUB)}, shortCircuit: true } : next(specifier, context); }`,
    ),
);

try {
  const { pipeline, env } = await import("@xenova/transformers");
  env.cacheDir = MODEL_CACHE_DIR;
  env.backends.onnx.wasm.numThreads = 1;

  console.log(`[prefetch-embedding-model] downloading Xenova/all-MiniLM-L6-v2 into ${MODEL_CACHE_DIR}...`);
  await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true });
  console.log("[prefetch-embedding-model] done.");
} catch (err) {
  // Non-fatal: a dev machine without internet, or any other failure here,
  // just means every container boots with keyword-only ranking (a
  // degradation, not a crash) until this is re-run somewhere with network
  // access — consistent with embeddings.ts's own fail-soft design.
  console.error(`[prefetch-embedding-model] WARNING: failed to prefetch embedding model (${err}) — semantic search will fall back to keyword-only ranking until this succeeds.`);
}
