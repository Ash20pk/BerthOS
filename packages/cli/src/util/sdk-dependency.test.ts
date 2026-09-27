import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sdkDependency } from "./sdk-dependency.js";

async function fakeSdk(version: string, withBundle: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "berth-sdk-dep-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@berthos/sdk", version }));
  if (withBundle) {
    await mkdir(join(root, "dist-external"));
    await writeFile(join(root, "dist-external", "berth-sdk.tgz"), "");
  }
  return root;
}

test("a checkout vendors the bundled SDK", async () => {
  const root = await fakeSdk("0.2.1", true);
  assert.deepEqual(sdkDependency(root), {
    spec: "file:./vendor/berth-sdk.tgz",
    tarballPath: join(root, "dist-external", "berth-sdk.tgz"),
  });
});

test("an npm-installed CLI depends on the published SDK at its own version", async () => {
  // The regression: with no bundle, berth init warned and left the templates'
  // "^0.1.0", which under 0.x caret rules matches nothing that was published.
  const root = await fakeSdk("0.2.1", false);
  assert.deepEqual(sdkDependency(root), { spec: "^0.2.1" });
});

test("an SDK with no version is an error, not a silent placeholder", async () => {
  const root = await mkdtemp(join(tmpdir(), "berth-sdk-dep-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@berthos/sdk" }));
  assert.throws(() => sdkDependency(root), /no version/);
});
