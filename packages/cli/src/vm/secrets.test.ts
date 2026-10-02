import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRETS_FILE, SECRETS_MAGIC, encodeSecretsDisk, hasSecrets, removeSecretsDisk, vmSecrets, writeSecretsDisk } from "./secrets.js";

const apps = [
  { name: "gh", manifest: { secrets: ["GITHUB_TOKEN"] } },
  { name: "notes", manifest: {} },
];

test("a declared name goes to the apps that declare it, any other to every app, and a missing one is named", () => {
  const s = vmSecrets({ GITHUB_TOKEN: "ghp_1", GITHUB_REPO: "o/r" }, [...apps, { name: "ci", manifest: { secrets: ["GITHUB_TOKEN", "NPM_TOKEN"] } }]);
  assert.deepEqual(s.shared, { GITHUB_REPO: "o/r" });
  assert.deepEqual(s.perApp, { gh: { GITHUB_TOKEN: "ghp_1" }, ci: { GITHUB_TOKEN: "ghp_1" } });
  assert.deepEqual(s.missing, [{ app: "ci", name: "NPM_TOKEN" }]);
  assert.equal(hasSecrets({ shared: {}, perApp: { gh: {} } }), false);
  assert.equal(hasSecrets(s), true);
});

test("the disk is the magic line, the JSON, and NUL padding to whole sectors", () => {
  const disk = encodeSecretsDisk({ shared: { A: "1" }, perApp: { gh: { PEM: "-----BEGIN-----\nab cd\n" } } });
  assert.equal(disk.length % 512, 0);
  const text = disk.toString("utf8");
  assert.ok(text.startsWith(SECRETS_MAGIC));
  const json = text.slice(SECRETS_MAGIC.length, text.indexOf("\0"));
  assert.deepEqual(JSON.parse(json), { shared: { A: "1" }, apps: { gh: { PEM: "-----BEGIN-----\nab cd\n" } } });
  assert.ok(disk.subarray(SECRETS_MAGIC.length + Buffer.byteLength(json)).every((b) => b === 0));
});

test("a value too large for the disk, or holding a NUL, is refused without quoting it", () => {
  assert.throws(() => encodeSecretsDisk({ shared: { BIG: "x".repeat(1 << 20) }, perApp: {} }), (e: Error) => /more than/.test(e.message) && !e.message.includes("xxxx"));
  assert.throws(() => encodeSecretsDisk({ shared: { K: "a\0hunter2" }, perApp: {} }), (e: Error) => /NUL/.test(e.message) && !e.message.includes("hunter2"));
});

test("the file is 0600, replaces a stale one, and is removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "berth-vm-secrets-"));
  writeFileSync(join(dir, SECRETS_FILE), "stale", { mode: 0o644 });
  const path = writeSecretsDisk(dir, { shared: { A: "1" }, perApp: {} });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(readFileSync(path, "utf8").startsWith(SECRETS_MAGIC));
  removeSecretsDisk(dir);
  assert.throws(() => statSync(path));
});
