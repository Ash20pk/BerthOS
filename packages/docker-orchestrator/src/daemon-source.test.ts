import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonSourceDir } from "./image.js";

// A fake packages/ directory: <root>/docker-orchestrator is the package.
function layout(withSiblings: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "berth-daemon-src-"));
  const pkgRoot = join(root, "docker-orchestrator");
  mkdirSync(pkgRoot);
  if (withSiblings) {
    for (const d of ["agent-init", "context-bus-daemon", "mesh-daemon"]) {
      mkdirSync(join(root, d));
      writeFileSync(join(root, d, "Cargo.toml"), "");
    }
    mkdirSync(join(root, "semantic-fs-daemon"));
    writeFileSync(join(root, "semantic-fs-daemon", "go.mod"), "");
  }
  return pkgRoot;
}

test("in a checkout, the sibling package's source is used", () => {
  const pkgRoot = layout(true);
  assert.equal(daemonSourceDir("agent-init", pkgRoot), join(pkgRoot, "..", "agent-init"));
  assert.equal(daemonSourceDir("semantic-fs-daemon", pkgRoot), join(pkgRoot, "..", "semantic-fs-daemon"));
});

test("in an npm install there is no sibling, so the bundled copy is used", () => {
  // The regression: an npm-installed CLI looked for node_modules/@berthos/
  // context-bus-daemon and failed every image build with ENOENT.
  const pkgRoot = layout(false);
  for (const d of ["agent-init", "context-bus-daemon", "semantic-fs-daemon", "mesh-daemon"]) {
    assert.equal(daemonSourceDir(d, pkgRoot), join(pkgRoot, "daemons", d));
  }
});

test("a sibling folder without the daemon's manifest isn't mistaken for its source", () => {
  const pkgRoot = layout(false);
  mkdirSync(join(pkgRoot, "..", "mesh-daemon"));
  assert.equal(daemonSourceDir("mesh-daemon", pkgRoot), join(pkgRoot, "daemons", "mesh-daemon"));
});
