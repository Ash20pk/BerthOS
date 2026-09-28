import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_RUNTIME_CONTEXT_DIR, PRIMARY_RUNTIME_ENTRY, excludedFromPythonImage, stageAppRuntimes } from "./app-runtime.js";

function app(root: string, name: string, manifestExtra: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "berth.yml"), `name: ${name}\nversion: 1.0.0\n${manifestExtra}`);
  return dir;
}

test("each app's runtime is resolved by the manifest loader and staged for the image", async () => {
  const root = mkdtempSync(join(tmpdir(), "berth-runtime-"));
  const primary = app(root, "py-primary", 'runtime: "python" # quoted, with a comment\n');
  const companion = app(root, "ts-companion", "");
  const flow = app(root, "py-flow", "runtime:   python\n");
  const staging = join(root, "staging");

  await stageAppRuntimes(staging, [
    { name: "py-primary", appDir: primary },
    { name: "ts-companion", appDir: companion },
    { name: "py-flow", appDir: flow },
  ]);

  const dir = join(staging, APP_RUNTIME_CONTEXT_DIR);
  const read = (entry: string) => readFileSync(join(dir, entry), "utf8");
  assert.equal(read("py-primary"), "python\n");
  assert.equal(read("ts-companion"), "node\n", "no runtime: means node");
  assert.equal(read("py-flow"), "python\n");
  assert.equal(read(PRIMARY_RUNTIME_ENTRY), "python\n", "single-app mode reads the first app's entry");
  assert.deepEqual(readdirSync(dir).sort(), ["_primary", "py-flow", "py-primary", "ts-companion"]);
});

test("the directory exists even for one Node app, because the Dockerfile always copies it", async () => {
  const root = mkdtempSync(join(tmpdir(), "berth-runtime-"));
  const staging = join(root, "staging");
  await stageAppRuntimes(staging, [{ name: "only", appDir: app(root, "only", "") }]);
  assert.equal(readFileSync(join(staging, APP_RUNTIME_CONTEXT_DIR, PRIMARY_RUNTIME_ENTRY), "utf8"), "node\n");
});

test("an invalid runtime fails the build rather than being guessed", async () => {
  const root = mkdtempSync(join(tmpdir(), "berth-runtime-"));
  await assert.rejects(stageAppRuntimes(join(root, "staging"), [{ name: "bad", appDir: app(root, "bad", "runtime: ruby\n") }]));
});

/** Every file under `dir`, relative, sorted. */
function tree(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? tree(dir, join(prefix, entry.name)) : [join(prefix, entry.name)]))
    .sort();
}

test("a Python app's production copy leaves out virtualenvs, bytecode, VCS history and .env files", async () => {
  const root = mkdtempSync(join(tmpdir(), "berth-py-stage-"));
  const appDir = join(root, "venv"); // the app directory's own name never excludes it
  const files = [
    "berth.yml",
    "src/app.py",
    "src/pkg/mod.py",
    "requirements.txt",
    "envelope.py",
    ".venv/bin/python",
    "venv/lib/site.py",
    "src/__pycache__/app.cpython-312.pyc",
    "src/stray.pyc",
    ".git/config",
    ".env",
    ".env.local",
    "src/.env",
    ".pytest_cache/v/cache",
    ".mypy_cache/3.12/x.json",
    "node_modules/x/index.js",
    ".berth/capability-policy.json",
  ];
  for (const file of files) {
    mkdirSync(join(appDir, file, ".."), { recursive: true });
    writeFileSync(join(appDir, file), "x");
  }
  const staging = join(root, "staging");
  await cp(appDir, staging, { recursive: true, filter: (src) => !excludedFromPythonImage(appDir, src) });

  assert.deepEqual(tree(staging), ["berth.yml", "envelope.py", "requirements.txt", "src/app.py", "src/pkg/mod.py"].sort());
});
