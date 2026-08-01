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
import { fileURLToPath } from "node:url";

const MODEL_CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "models");

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
