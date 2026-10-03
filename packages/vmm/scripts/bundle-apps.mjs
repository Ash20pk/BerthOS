#!/usr/bin/env node
// Bundles what the berth-init guest needs to run resident apps without a
// node_modules tree (the multi-app successor of bundle-notes.mjs):
//
//   <out>/generate-capability-policy.mjs   the root-run policy compiler,
//                                          from POLICY_REPO (a checkout or a
//                                          `git archive` of a ref, so the
//                                          compiler can come from a branch
//                                          this one is not built on yet)
//   <out>/runtime.mjs                      @berthos/sdk's resident-app runtime
//   <out>/apps/<app>.mjs                   apps/<app> with the SDK and zod inlined
//
// Usage: node bundle-apps.mjs <out> <repo> <policy-repo> <app[=dir],...> <node_modules dir>...
// esbuild, yaml, zod and protobufjs are resolved from the given node_modules
// directories (an existing checkout's installed tree, read only).
import { createRequire, builtinModules } from "node:module";
import { join } from "node:path";

const [outDir, repo, policyRepo, appList, ...nodePaths] = process.argv.slice(2);
if (!outDir || !repo || !policyRepo || !appList || nodePaths.length === 0) {
  console.error("usage: bundle-apps.mjs <out> <repo> <policy-repo> <app,app,...> <node_modules dir>...");
  process.exit(2);
}
let esbuild;
for (const p of nodePaths) {
  try {
    esbuild = createRequire(join(p, "noop.js"))("esbuild");
    break;
  } catch {}
}
if (!esbuild) throw new Error("esbuild not found in the given node_modules paths");

const options = (root, entryPoints, outdir) => ({
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outdir,
  outExtension: { ".js": ".mjs" },
  nodePaths,
  entryPoints,
  alias: {
    "@berthos/sdk": join(root, "packages/sdk/src/index.ts"),
    "@berthos/manifest-schema": join(root, "packages/manifest-schema/src/index.ts"),
  },
  banner: { js: 'import { createRequire as __berthCreateRequire } from "node:module"; const require = __berthCreateRequire(import.meta.url);' },
  // What an optional layer provides (the CLI's bundle.ts does the same):
  // playwright-core from the browser layer, by absolute path.
  plugins: [
    {
      name: "berth-layer-imports",
      setup(b) {
        b.onResolve({ filter: /^playwright-core$/ }, () => ({ path: "/usr/lib/berth/node_modules/playwright-core/index.mjs", external: true }));
      },
    },
  ],
  metafile: true,
  logLevel: "warning",
});

const builtin = (p) => p.startsWith("node:") || builtinModules.includes(p);
const check = (result) => {
  for (const [file, output] of Object.entries(result.metafile.outputs)) {
    const bare = output.imports.filter((i) => i.external && !builtin(i.path) && !i.path.startsWith("/usr/lib/berth/"));
    if (bare.length > 0) throw new Error(`${file} still imports ${bare.map((i) => i.path).join(", ")}`);
    console.log(`${file}: ${(output.bytes / 1024).toFixed(0)} KiB`);
  }
};

check(await esbuild.build(options(policyRepo, { "generate-capability-policy": join(policyRepo, "packages/sdk/src/generate-capability-policy.ts") }, outDir)));
check(await esbuild.build(options(repo, { runtime: join(repo, "packages/sdk/src/runtime.ts") }, outDir)));
// "<app>" is apps/<app>; "<app>=<dir>" is an app directory elsewhere in the repo
// (the e2e's test app: probe=packages/vmm/guest/probe-app).
const apps = Object.fromEntries(
  appList.split(",").map((a) => {
    const [name, dir] = a.split("=");
    return [name, join(repo, dir ?? join("apps", name), "src/index.ts")];
  }),
);
check(await esbuild.build(options(repo, apps, join(outDir, "apps"))));
