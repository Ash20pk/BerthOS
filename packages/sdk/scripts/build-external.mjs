#!/usr/bin/env node
// Produces a self-contained, publishable @berth/sdk artifact for genuinely
// external consumers: everything workspace-internal (currently just
// @berth/manifest-schema) is inlined by esbuild; only real npm packages
// (zod, protobufjs) stay as declared dependencies. `berth init` vendors the
// resulting tarball into scaffolded projects as a `file:` dependency so
// `pnpm install` works with zero access to this monorepo's pnpm workspace —
// see packages/cli/src/commands/init.ts's vendorSdk().
import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, relative, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_SCHEMA_ROOT = join(PACKAGE_ROOT, "..", "manifest-schema");
const OUT_DIR = join(PACKAGE_ROOT, "dist-external");

const pkg = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf-8"));
const manifestPkg = JSON.parse(await readFile(join(MANIFEST_SCHEMA_ROOT, "package.json"), "utf-8"));
// Real npm packages stay external — including "yaml", which @berth/sdk only
// depends on transitively via the inlined @berth/manifest-schema, but which
// must still be resolvable at runtime (esbuild can't safely bundle its CJS
// dynamic-require internals into an ESM output). "@xenova/transformers" is
// the same story, more so — its backend-selection code branches on
// platform/environment and does its own dynamic module resolution (ONNX
// runtime WASM/native backends), which esbuild bundling would break.
const EXTERNAL_DEPS = ["zod", "protobufjs", "yaml", "@xenova/transformers"];

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

await build({
  entryPoints: {
    index: join(PACKAGE_ROOT, "src", "index.ts"),
    runtime: join(PACKAGE_ROOT, "src", "runtime.ts"),
  },
  outdir: OUT_DIR,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: EXTERNAL_DEPS,
  // No banner here — runtime.ts already carries its own `#!/usr/bin/env node`
  // shebang, and esbuild preserves a source's leading shebang verbatim; a
  // banner would duplicate it as an invalid second line.
});

await cp(join(PACKAGE_ROOT, "proto"), join(OUT_DIR, "proto"), { recursive: true });
// Only present if scripts/prefetch-embedding-model.mjs succeeded during
// `pnpm install` (network-dependent, non-fatal if it didn't) — embeddings.ts
// fails soft to keyword-only ranking if this directory is absent.
await cp(join(PACKAGE_ROOT, "models"), join(OUT_DIR, "models"), { recursive: true, force: true }).catch(() => {});

// esbuild inlines @berth/manifest-schema's *code* into the JS bundle above,
// but a consuming app's own `tsc` still needs its *types* (BerthManifest
// leaks into AppContext's public shape) — @berth/manifest-schema isn't a
// declared dependency of the external package, so mirror its .d.ts tree
// alongside the SDK's own and rewrite the one bare-specifier import that
// crosses that boundary (app.d.ts) to a relative path.
async function copyDeclarations(srcDir, destDir) {
  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await copyDeclarations(join(srcDir, entry.name), join(destDir, entry.name));
      continue;
    }
    if (!entry.name.endsWith(".d.ts") || entry.name.endsWith(".test.d.ts")) continue;
    await mkdir(destDir, { recursive: true });
    await cp(join(srcDir, entry.name), join(destDir, entry.name));
  }
}

await copyDeclarations(join(PACKAGE_ROOT, "dist"), OUT_DIR);
await copyDeclarations(join(MANIFEST_SCHEMA_ROOT, "dist"), join(OUT_DIR, "manifest-schema"));

async function rewriteManifestSchemaImports(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await rewriteManifestSchemaImports(entryPath);
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) continue;
    const contents = await readFile(entryPath, "utf-8");
    if (!contents.includes("@berth/manifest-schema")) continue;
    const relPath = relative(dirname(entryPath), join(OUT_DIR, "manifest-schema", "index.js")).split(sep).join(posix.sep);
    const specifier = relPath.startsWith(".") ? relPath : `./${relPath}`;
    await writeFile(entryPath, contents.replaceAll("@berth/manifest-schema", specifier));
  }
}
await rewriteManifestSchemaImports(OUT_DIR);

const externalPkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  type: "module",
  main: "./index.js",
  types: "./index.d.ts",
  exports: {
    ".": { types: "./index.d.ts", default: "./index.js" },
    "./runtime": { types: "./runtime.d.ts", default: "./runtime.js" },
  },
  bin: { "berth-runtime": "./runtime.js" },
  files: ["index.js", "index.d.ts", "runtime.js", "runtime.d.ts", "proto", "models", "*.d.ts", "manifest-schema", "context-bus", "semantic-fs"],
  dependencies: Object.fromEntries(
    EXTERNAL_DEPS.map((name) => [name, pkg.dependencies[name] ?? manifestPkg.dependencies[name]]),
  ),
};
await writeFile(join(OUT_DIR, "package.json"), JSON.stringify(externalPkg, null, 2));

// `npm pack` (not a hand-rolled tar) so the artifact is a real, standard,
// installable package tarball — same format any `npm install <tgz>` expects.
await execFileAsync("npm", ["pack", "--silent", "--pack-destination", OUT_DIR], { cwd: OUT_DIR });

// npm names the tarball from the scoped package name (@berth/sdk -> berth-sdk-<version>.tgz);
// give it a fixed name so consumers don't need to know the version to find it.
const tgz = (await readdir(OUT_DIR)).find((f) => f.endsWith(".tgz"));
await cp(join(OUT_DIR, tgz), join(OUT_DIR, "berth-sdk.tgz"));
await rm(join(OUT_DIR, tgz));

console.log(`[build-external] wrote ${join(OUT_DIR, "berth-sdk.tgz")}`);
