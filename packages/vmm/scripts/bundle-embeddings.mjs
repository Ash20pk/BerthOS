#!/usr/bin/env node
// The embeddings kit the base rootfs carries at /usr/share/berth/embeddings,
// so that an app's semantic-fs tag() and query() rank by meaning in a
// microVM as they do in a container (docs/design/microvm-semantic-fs.md,
// section 7). The SDK loads it when BERTH_EMBEDDINGS_DIR names it
// (packages/sdk/src/semantic-fs/embeddings.ts), which berth-init sets.
//
//   transformers.mjs        @xenova/transformers and its ONNX runtime (the
//                           WASM one: onnxruntime-node resolves to it in this
//                           repo), bundled into one ES module. Its banner
//                           defines require, __filename and __dirname, which
//                           the bundled CommonJS parts use and which an ES
//                           module otherwise lacks (what failed in an app's
//                           own bundle). sharp resolves to the SDK's stub.
//   ort-wasm-simd.wasm      the single-threaded SIMD runtime (the SDK runs with
//                           numThreads 1, and the threaded ones need workers;
//                           Node 22 on arm64 always has WASM SIMD, so the
//                           plain one, 9 MB more, would never load)
//   daemon.mjs              guest/embeddings-daemon.mjs: the one process that
//                           loads the model, for every app in the sandbox
//   models/Xenova/all-MiniLM-L6-v2/...
//                           the quantized model, from packages/sdk/models
//                           (fetched at pnpm install)
//
// Bundled with the checkout as esbuild's working directory, so the `// path`
// comments esbuild writes are the same wherever the checkout is.
//
// Usage: node bundle-embeddings.mjs <outdir> <checkout with node_modules>
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [outArg, rootArg] = process.argv.slice(2);
if (!outArg || !rootArg) {
  console.error("usage: bundle-embeddings.mjs <outdir> <checkout with node_modules>");
  process.exit(2);
}
const out = resolve(outArg);
const root = realpathSync(resolve(rootArg));
const sdk = join(root, "packages", "sdk");
const fromSdk = createRequire(join(sdk, "package.json"));
const esbuild = fromSdk("esbuild");
const transformersDir = dirname(fromSdk.resolve("@xenova/transformers/package.json"));
const fromTransformers = createRequire(join(transformersDir, "package.json"));
const ortDist = join(dirname(fromTransformers.resolve("onnxruntime-web/package.json")), "dist");
const models = join(sdk, "models", "Xenova", "all-MiniLM-L6-v2");
if (!existsSync(join(models, "onnx", "model_quantized.onnx"))) throw new Error(`no model at ${models}: run pnpm install (packages/sdk's postinstall fetches it)`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await esbuild.build({
  entryPoints: [join(transformersDir, "src", "transformers.js")],
  absWorkingDir: root,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(out, "transformers.mjs"),
  banner: {
    js: [
      'import { createRequire as __berthRequire } from "node:module";',
      'import { fileURLToPath as __berthPath } from "node:url";',
      'import { dirname as __berthDir } from "node:path";',
      "const require = __berthRequire(import.meta.url);",
      "const __filename = __berthPath(import.meta.url);",
      "const __dirname = __berthDir(__filename);",
    ].join("\n"),
  },
  logLevel: "error",
});
cpSync(join(ortDist, "ort-wasm-simd.wasm"), join(out, "ort-wasm-simd.wasm"));
cpSync(join(dirname(fileURLToPath(import.meta.url)), "..", "guest", "embeddings-daemon.mjs"), join(out, "daemon.mjs"));
cpSync(models, join(out, "models", "Xenova", "all-MiniLM-L6-v2"), { recursive: true });

let files = 0;
let bytes = 0;
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(d, e.name));
    else {
      files++;
      bytes += statSync(join(d, e.name)).size;
    }
  }
};
walk(out);
console.log(JSON.stringify({ esbuild: esbuild.version, transformers: fromTransformers("./package.json").version, files, bytes }));
