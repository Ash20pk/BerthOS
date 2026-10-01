import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleApp } from "./bundle.js";

// A project outside this repo with no node_modules, as `berth init` leaves
// one before `npm install`: esbuild, @berthos/sdk and zod come from the CLI.
function project() {
  const dir = mkdtempSync(join(tmpdir(), "berth-bundle-"));
  const app = join(dir, "hello");
  mkdirSync(join(app, "src"), { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "hello", type: "module", dependencies: { "@berthos/sdk": "*", zod: "*" } }));
  writeFileSync(join(app, "berth.yml"), "name: hello\nversion: 0.1.0\ncapabilities: []\nexports:\n  - name: ping\n    output: { message: string }\n");
  writeFileSync(
    join(app, "src", "index.ts"),
    `import { defineApp } from "@berthos/sdk";\nimport { z } from "zod";\nimport { greeting } from "./greeting.js";\nexport default defineApp((app) => {\n  app.export({ name: "ping", output: z.object({ message: z.string() }), handler: () => ({ message: greeting }) });\n});\n`,
  );
  writeFileSync(join(app, "src", "greeting.ts"), `export const greeting: string = "pong";\n`);
  return { app, cache: join(dir, "cache") };
}

test("bundles an app outside the repo against the CLI's SDK, into the share layout berth-init runs", async () => {
  const p = project();
  const b = await bundleApp(p.app, "hello", { cacheRoot: p.cache });
  assert.equal(b.cached, false);
  assert.equal(b.sdkFrom, "cli");
  assert.ok(b.shareDir.endsWith("/hello"), "the share's directory name is the app name (berth-vmm's multi-app tag)");
  for (const f of ["berth.yml", "runtime.mjs", "dist/index.mjs", "proto/context_bus.proto"]) assert.ok(existsSync(join(b.shareDir, f)), f);
  const app = readFileSync(join(b.shareDir, "dist/index.mjs"), "utf8");
  assert.match(app, /pong/);
  assert.doesNotMatch(app, /from "zod"|from "@berthos\/sdk"/, "dependencies are inlined");
});

test("an unchanged app is a cache hit; a changed or added file rebundles", async () => {
  const p = project();
  const first = await bundleApp(p.app, "hello", { cacheRoot: p.cache });
  const again = await bundleApp(p.app, "hello", { cacheRoot: p.cache });
  assert.equal(again.cached, true);
  assert.equal(again.shareDir, first.shareDir);

  writeFileSync(join(p.app, "src", "greeting.ts"), `export const greeting: string = "pong 2";\n`);
  const changed = await bundleApp(p.app, "hello", { cacheRoot: p.cache });
  assert.equal(changed.cached, false);
  assert.notEqual(changed.hash, first.hash);
  assert.match(readFileSync(join(changed.shareDir, "dist/index.mjs"), "utf8"), /pong 2/);

  // A new file nothing imports yet still invalidates (it can change how an import resolves).
  writeFileSync(join(p.app, "src", "unused.ts"), "export const x = 1;\n");
  const added = await bundleApp(p.app, "hello", { cacheRoot: p.cache });
  assert.equal(added.cached, false);
  assert.equal(added.hash, changed.hash, "same output, so the same share");

  writeFileSync(join(p.app, "berth.yml"), readFileSync(join(p.app, "berth.yml"), "utf8") + "on_install: []\n");
  assert.equal((await bundleApp(p.app, "hello", { cacheRoot: p.cache })).cached, false, "berth.yml is an input");
});

test("an import nothing provides is a clear error", async () => {
  const p = project();
  writeFileSync(join(p.app, "src", "greeting.ts"), `import "left-pad-that-does-not-exist";\nexport const greeting = "x";\n`);
  await assert.rejects(bundleApp(p.app, "hello", { cacheRoot: p.cache }), /can't bundle hello for the VM: Could not resolve "left-pad-that-does-not-exist"/);
});
