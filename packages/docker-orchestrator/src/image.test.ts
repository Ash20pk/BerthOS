import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDeployReproducible } from "./image.js";

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
