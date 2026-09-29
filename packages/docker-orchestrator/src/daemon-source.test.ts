import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonSourceDir, pythonSdkSourceDir } from "./image.js";

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

test("the Python SDK comes from the checkout when there is one, else the bundled copy", () => {
  const pkgRoot = layout(false);
  assert.equal(pythonSdkSourceDir(pkgRoot), join(pkgRoot, "daemons", "sdk-python"));

  // A sibling sdk-python without berth_sdk/__init__.py is not the SDK.
  mkdirSync(join(pkgRoot, "..", "sdk-python", "berth_sdk"), { recursive: true });
  assert.equal(pythonSdkSourceDir(pkgRoot), join(pkgRoot, "daemons", "sdk-python"));

  writeFileSync(join(pkgRoot, "..", "sdk-python", "berth_sdk", "__init__.py"), "");
  assert.equal(pythonSdkSourceDir(pkgRoot), join(pkgRoot, "..", "sdk-python"));
});

test("an app's own pnpm-workspace.yaml doesn't make it a workspace member", async () => {
  // berth init writes pnpm-workspace.yaml into every scaffolded project. The
  // production build treated that as a monorepo and ran `pnpm deploy`, which
  // fails for a standalone app.
  const { workspaceRootAbove } = await import("./image.js");
  const root = mkdtempSync(join(tmpdir(), "berth-ws-"));
  const app = join(root, "my-app");
  mkdirSync(app);
  writeFileSync(join(app, "pnpm-workspace.yaml"), "allowBuilds:\n  protobufjs: true\n");
  assert.equal(workspaceRootAbove(app), undefined);

  // A real monorepo root above the app still counts.
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - my-app\n");
  assert.equal(workspaceRootAbove(app), root);
});
