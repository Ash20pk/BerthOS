import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { makeDeployReproducible, stageProductionSource } from "./image.js";

// A tree shaped like `pnpm deploy --legacy` output, with each thing that made
// two builds of the same app differ, or dangle inside the image.
function deployedTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "berth-deploy-"));
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(dir, "node_modules", ".pnpm", "dep@1", "node_modules", "dep"), { recursive: true });
  writeFileSync(join(dir, "node_modules", ".bin", "tool"), `#!/bin/sh\nexport NODE_PATH="${dir}/node_modules/.pnpm/node_modules"\nexec node "$basedir/../dep/cli.js"\n`);
  writeFileSync(join(dir, "node_modules", ".modules.yaml"), `prunedAt: ${new Date().toISOString()}\nvirtualStoreDir: ${dir}/node_modules/.pnpm\n`);
  symlinkSync("../../../../../Users/someone/checkout/apps/notes", join(dir, "node_modules", "escaping"));
  symlinkSync(".pnpm/dep@1/node_modules/dep", join(dir, "node_modules", "dep"));
  return dir;
}

test("the deploy path in .bin shims becomes the app's path in the image", async () => {
  const dir = deployedTree();
  try {
    await makeDeployReproducible(dir, "/app/apps/notes");
    const shim = readFileSync(join(dir, "node_modules", ".bin", "tool"), "utf-8");
    assert.ok(!shim.includes(dir), shim);
    assert.match(shim, /NODE_PATH="\/app\/apps\/notes\/node_modules\/\.pnpm\/node_modules"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pnpm's bookkeeping and links out of the tree are removed; links inside stay", async () => {
  const dir = deployedTree();
  try {
    await makeDeployReproducible(dir, "/app");
    assert.equal(existsSync(join(dir, "node_modules", ".modules.yaml")), false);
    assert.throws(() => lstatSync(join(dir, "node_modules", "escaping")), /ENOENT/);
    assert.ok(lstatSync(join(dir, "node_modules", "dep")).isSymbolicLink());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two deploys of the same app end up byte-identical", async () => {
  const a = deployedTree();
  const b = deployedTree();
  try {
    await makeDeployReproducible(a, "/app");
    await makeDeployReproducible(b, "/app");
    const shim = (d: string) => readFileSync(join(d, "node_modules", ".bin", "tool"), "utf-8");
    assert.equal(shim(a), shim(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

/** Every path in a tree, with its content hash or link target — what a `COPY` layer's cache key is made of. */
function treeDigest(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (entry.isSymbolicLink()) out.push(`${rel} -> ${readlinkSync(path)}`);
      else if (entry.isDirectory()) walk(path);
      else out.push(`${rel} ${lstatSync(path).mode.toString(8)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    }
  };
  walk(root);
  return out.sort();
}

function hasPnpm(): boolean {
  try {
    execFileSync("pnpm", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// A `berth init`-shaped project: not a workspace member, so staging takes the
// plain `pnpm install --prod` branch. The dependency is local (and has a bin,
// so there are shims to get wrong) so the test needs no registry.
function standaloneApp(): string {
  const dir = mkdtempSync(join(tmpdir(), "berth-standalone-"));
  mkdirSync(join(dir, "vendor", "probe-tool"), { recursive: true });
  writeFileSync(
    join(dir, "vendor", "probe-tool", "package.json"),
    JSON.stringify({ name: "probe-tool", version: "1.0.0", bin: { "probe-tool": "cli.js" } }),
  );
  writeFileSync(join(dir, "vendor", "probe-tool", "cli.js"), "#!/usr/bin/env node\nconsole.log('probe');\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "standalone-probe", version: "0.1.0", type: "module", dependencies: { "probe-tool": "file:./vendor/probe-tool" } }),
  );
  writeFileSync(join(dir, "index.js"), "export {};\n");
  return dir;
}

test("two stagings of the same standalone app are identical", { skip: !hasPnpm() && "pnpm is not installed" }, async () => {
  const app = standaloneApp();
  const a = mkdtempSync(join(tmpdir(), "berth-build-"));
  const b = mkdtempSync(join(tmpdir(), "berth-build-"));
  try {
    await stageProductionSource(app, join(a, "app"), "/app");
    await stageProductionSource(app, join(b, "app"), "/app");
    // The install actually happened, with a shim, so the comparison below
    // is between two real installs rather than two empty trees.
    assert.ok(existsSync(join(a, "app", "node_modules", ".bin", "probe-tool")));
    assert.deepEqual(treeDigest(join(a, "app")), treeDigest(join(b, "app")));
    for (const line of treeDigest(join(a, "app"))) assert.ok(!line.includes(a), line);
  } finally {
    for (const dir of [app, a, b]) rmSync(dir, { recursive: true, force: true });
  }
});
