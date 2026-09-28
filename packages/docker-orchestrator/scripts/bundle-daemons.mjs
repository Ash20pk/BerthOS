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
