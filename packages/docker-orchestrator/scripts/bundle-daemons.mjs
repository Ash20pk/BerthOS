#!/usr/bin/env node
// Copies the sandbox daemons' source into this package, under daemons/, so
// the published @berthos/docker-orchestrator can build an image on its own.
//
// Every image build compiles agent-init, context-bus-daemon and mesh-daemon
// (Rust) and semantic-fs-daemon (Go) inside Docker, from their source. In
// this repository that source sits next to this package (packages/<daemon>);
// in an npm install it doesn't, so without this copy no image could be built
// from a published CLI. Run as part of `build`, so every pack includes it.
//
// Only git-tracked files are copied: that excludes Cargo's target/, a
// locally built Go binary, and anything else a developer has lying around.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const DAEMONS = ["agent-init", "context-bus-daemon", "semantic-fs-daemon", "mesh-daemon"];

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(pkgRoot, "..");
const outDir = join(pkgRoot, "daemons");

rmSync(outDir, { recursive: true, force: true });
for (const daemon of DAEMONS) {
  const srcDir = join(packagesDir, daemon);
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "."], { cwd: srcDir, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  if (tracked.length === 0) throw new Error(`bundle-daemons: no tracked files under ${relative(pkgRoot, srcDir)}`);
  for (const file of tracked) {
    const dest = join(outDir, daemon, file);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(srcDir, file), dest);
  }
  console.log(`bundle-daemons: ${daemon} (${tracked.length} files)`);
}

// berth_sdk, the Python resident-app SDK: every image carries it at
// /opt/berth/sdk-python so a `runtime: python` app runs outside a checkout too.
{
  const srcDir = join(packagesDir, "sdk-python", "berth_sdk");
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "."], { cwd: srcDir, encoding: "utf8" })
    .split("\0")
    .filter((f) => f && f.endsWith(".py"));
  if (tracked.length === 0) throw new Error("bundle-daemons: no tracked files under sdk-python/berth_sdk");
  for (const file of tracked) {
    const dest = join(outDir, "sdk-python", "berth_sdk", file);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(srcDir, file), dest);
  }
  console.log(`bundle-daemons: sdk-python (${tracked.length} files)`);
}

// @berthos/sdk's root-run tools: the capability-policy compiler and the
// lifecycle flags, which entrypoint.sh runs as uid 0 before agent-init has
// applied anything. Each is one self-contained file, with
// @berthos/manifest-schema, yaml and zod inlined, so that running it resolves
// no bare import at all. Every image carries them at /opt/berth/sdk-node,
// root-owned.
//
// They used to run from the app's own node_modules/@berthos/sdk, with the
// app's directory as the current one. A bare import there is looked up in
// node_modules/@berthos/sdk/dist/node_modules first, which no image has, and
// which an app could declare filesystem:write: for, have created for it and
// fill with a module of its own, for root to run on the next boot.
{
  const { build } = await import("esbuild");
  const sdkSrc = join(packagesDir, "sdk", "src");
  const dest = join(outDir, "sdk-node");
  const result = await build({
    entryPoints: {
      "generate-capability-policy": join(sdkSrc, "generate-capability-policy.ts"),
      "run-lifecycle": join(sdkSrc, "run-lifecycle.ts"),
    },
    outdir: dest,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    // yaml's CJS internals call require(); an ESM bundle has none of its own.
    banner: { js: 'import { createRequire as __berthCreateRequire } from "node:module"; const require = __berthCreateRequire(import.meta.url);' },
    metafile: true,
    logLevel: "warning",
  });
  // Anything esbuild left as an import is resolved at run time, from wherever
  // the tool runs; only node's own modules may be.
  const { builtinModules } = await import("node:module");
  const builtin = (path) => path.startsWith("node:") || builtinModules.includes(path);
  for (const [file, output] of Object.entries(result.metafile.outputs)) {
    const bare = output.imports.filter((i) => i.external && !builtin(i.path));
    if (bare.length > 0) throw new Error(`bundle-daemons: ${file} still imports ${bare.map((i) => i.path).join(", ")}`);
  }
  console.log(`bundle-daemons: sdk-node (${Object.keys(result.metafile.outputs).length} files)`);
}
