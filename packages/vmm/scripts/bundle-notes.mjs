#!/usr/bin/env node
// Bundles what the guest needs to run apps/notes without a node_modules tree:
//   generate-capability-policy.mjs  - the root-run sdk-node tools the image
//   run-lifecycle.mjs                 carries at /opt/berth/sdk-node, built as
//                                     bundle-daemons.mjs builds them
//   runtime.mjs                     - @berthos/sdk's resident-app runtime
//   notes.mjs                       - apps/notes with @berthos/sdk and zod inlined
//
// Usage: node bundle-notes.mjs <outdir> <node_modules search path>...
// This worktree has no node_modules of its own, so esbuild, yaml and zod are
// resolved from an existing checkout's installed tree (read only).
import { createRequire } from "node:module";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [outDir, ...nodePaths] = process.argv.slice(2);
if (!outDir || nodePaths.length === 0) {
  console.error("usage: bundle-notes.mjs <outdir> <node_modules dir>...");
  process.exit(2);
}
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const require = createRequire(join(nodePaths[0], "noop.js"));
let esbuild;
for (const p of nodePaths) {
  try {
    esbuild = createRequire(join(p, "noop.js"))("esbuild");
    break;
  } catch {}
}
if (!esbuild) throw new Error("esbuild not found in the given node_modules paths");

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  nodePaths,
  alias: {
    "@berthos/sdk": join(repo, "packages/sdk/src/index.ts"),
    "@berthos/manifest-schema": join(repo, "packages/manifest-schema/src/index.ts"),
  },
  banner: { js: 'import { createRequire as __berthCreateRequire } from "node:module"; const require = __berthCreateRequire(import.meta.url);' },
  metafile: true,
  logLevel: "warning",
};

const result = await esbuild.build({
  ...common,
  entryPoints: {
    "generate-capability-policy": join(repo, "packages/sdk/src/generate-capability-policy.ts"),
    "run-lifecycle": join(repo, "packages/sdk/src/run-lifecycle.ts"),
    runtime: join(repo, "packages/sdk/src/runtime.ts"),
    notes: join(repo, "apps/notes/src/index.ts"),
  },
});

const builtin = (p) => p.startsWith("node:") || builtinModules.includes(p);
for (const [file, output] of Object.entries(result.metafile.outputs)) {
  const bare = output.imports.filter((i) => i.external && !builtin(i.path));
  if (bare.length > 0) throw new Error(`${file} still imports ${bare.map((i) => i.path).join(", ")}`);
  console.log(`${file}: ${(output.bytes / 1024).toFixed(0)} KiB`);
}
void require;
