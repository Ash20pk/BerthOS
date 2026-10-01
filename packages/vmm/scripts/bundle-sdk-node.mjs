#!/usr/bin/env node
// Bundles the root-run sdk-node tools the base rootfs carries at
// /opt/berth/sdk-node (generate-capability-policy.mjs, run-lifecycle.mjs), the
// way bundle-daemons.mjs builds them, so that the output depends only on the
// sources and the package versions, never on where they sit on disk.
//
// esbuild writes a `// <path>` comment above every module it inlines, relative
// to its working directory. Bundled in place, those paths name the checkout,
// the node_modules layout and the directory the script ran from, so the same
// sources gave a different image on another machine. Here everything is first
// staged into one directory with a fixed layout:
//
//   <stage>/packages/sdk/src, <stage>/packages/manifest-schema/src   the sources
//   <stage>/node_modules/<name>                                       each package they use
//
// and bundled with that directory as esbuild's working directory, so every
// comment reads `packages/sdk/src/...` or `node_modules/zod/...`.
//
// Usage: node bundle-sdk-node.mjs <stage> <outdir> <src root> <node_modules dir>...
//   <stage>     an empty directory (created)
//   <src root>  a directory holding packages/sdk/src and packages/manifest-schema/src
//               (a `git archive` of the pinned policy compiler commit)
//   node_modules dirs: where esbuild, yaml, zod, ... are resolved from (read only)
// Prints a JSON record of the packages inlined and the esbuild version.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { builtinModules, createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const [stageArg, outArg, srcArg, ...nodePathArgs] = process.argv.slice(2);
if (!stageArg || !outArg || !srcArg || nodePathArgs.length === 0) {
  console.error("usage: bundle-sdk-node.mjs <stage> <outdir> <src root> <node_modules dir>...");
  process.exit(2);
}
const stage = resolve(stageArg);
const outDir = resolve(outArg);
const nodePaths = nodePathArgs.map((p) => resolve(p)).filter((p) => existsSync(p));
if (existsSync(stage) && readdirSync(stage).length > 0) throw new Error(`${stage} is not empty`);

let esbuild;
for (const p of nodePaths) {
  try {
    esbuild = createRequire(join(p, "noop.js"))("esbuild");
    break;
  } catch {}
}
if (!esbuild) throw new Error("esbuild not found in the given node_modules paths");

// esbuild also reads the nearest package.json above each source file (its
// "type" and "sideEffects" change how modules are wrapped), so an empty one
// at the root keeps it from finding one in a parent directory: an empty
// package.json means the same as none.
const copySources = (root) => {
  for (const pkg of ["sdk", "manifest-schema"]) {
    cpSync(join(srcArg, "packages", pkg, "src"), join(root, "packages", pkg, "src"), { recursive: true });
  }
  writeFileSync(join(root, "package.json"), "{}\n");
};
copySources(stage);

const entryPoints = {
  "generate-capability-policy": "packages/sdk/src/generate-capability-policy.ts",
  "run-lifecycle": "packages/sdk/src/run-lifecycle.ts",
};
const options = (absWorkingDir, searchPaths, outdir) => ({
  absWorkingDir,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outdir,
  outExtension: { ".js": ".mjs" },
  nodePaths: searchPaths,
  alias: {
    "@berthos/sdk": join(absWorkingDir, "packages/sdk/src/index.ts"),
    "@berthos/manifest-schema": join(absWorkingDir, "packages/manifest-schema/src/index.ts"),
  },
  entryPoints: Object.fromEntries(Object.entries(entryPoints).map(([k, v]) => [k, join(absWorkingDir, v)])),
  banner: { js: 'import { createRequire as __berthCreateRequire } from "node:module"; const require = __berthCreateRequire(import.meta.url);' },
  metafile: true,
  write: true,
  logLevel: "warning",
});

// Pass 1, from the given node_modules: only to learn which packages are used.
// esbuild looks in every node_modules above the importing file before it
// tries nodePaths, so a stage under a directory with its own node_modules
// (a home directory with a package.json, say) would pick up whatever
// versions live there. The probe therefore runs from a fresh directory under
// the system temp dir, and every package it resolves must come from one of
// the node_modules directories given on the command line.
const probeRoot = realpathSync(mkdtempSync(join(tmpdir(), "berth-sdk-probe-")));
copySources(probeRoot);
const probe = await esbuild.build(options(probeRoot, nodePaths, join(probeRoot, ".probe")));
const allowed = nodePaths.map((p) => realpathSync(p) + sep);
const packages = new Map(); // name -> real package directory
for (const input of Object.keys(probe.metafile.inputs)) {
  const abs = realpathSync(isAbsolute(input) ? input : join(probeRoot, input));
  if (abs.startsWith(probeRoot + sep)) continue;
  if (!allowed.some((a) => abs.startsWith(a)) && !nodePaths.some((p) => abs.startsWith(p + sep))) {
    throw new Error(`${abs} was resolved from outside the given node_modules directories (${nodePaths.join(", ")})`);
  }
  // The package root: the nearest directory above the file with a package.json
  // that names a package and sits directly under a node_modules directory.
  let dir = dirname(abs);
  for (;;) {
    const parent = dirname(dir);
    const scoped = dirname(parent);
    const under = (d) => d.split(sep).pop() === "node_modules";
    if (existsSync(join(dir, "package.json")) && (under(parent) || (parent.split(sep).pop()?.startsWith("@") && under(scoped)))) break;
    if (parent === dir) throw new Error(`${abs} is not inside a node_modules package`);
    dir = parent;
  }
  const { name, version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const seen = packages.get(name);
  if (seen && seen.dir !== dir) throw new Error(`two copies of ${name}: ${seen.dir} and ${dir}`);
  packages.set(name, { dir, version });
}
for (const [name, { dir }] of packages) cpSync(dir, join(stage, "node_modules", name), { recursive: true, dereference: true });

// Pass 2, from the stage only: the output.
rmSync(probeRoot, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const built = await esbuild.build(options(stage, [join(stage, "node_modules")], outDir));
const builtin = (p) => p.startsWith("node:") || builtinModules.includes(p);
for (const input of Object.keys(built.metafile.inputs)) {
  const abs = resolve(stage, input);
  if (relative(stage, abs).startsWith("..")) throw new Error(`${input} resolved outside the stage`);
}
for (const [file, output] of Object.entries(built.metafile.outputs)) {
  const bare = output.imports.filter((i) => i.external && !builtin(i.path));
  if (bare.length > 0) throw new Error(`${file} still imports ${bare.map((i) => i.path).join(", ")}`);
}
const record = {
  bundler: `esbuild ${esbuild.version}`,
  packages: Object.fromEntries([...packages].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, { version }]) => [name, version])),
};
process.stdout.write(JSON.stringify(record) + "\n");
