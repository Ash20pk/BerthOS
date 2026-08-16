import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addOperator, LEGACY_OPERATOR_NAME, loadOperatorRegistry, singleTokenRegistry } from "./operators.js";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "berth-operators-"));
}

test("mints a default operator on first load and resolves its token", () => {
  const dataDir = dir();
  const { registry, mintedToken } = loadOperatorRegistry(dataDir);
  assert.ok(mintedToken);
  assert.equal(registry.resolve(mintedToken), LEGACY_OPERATOR_NAME);
});

test("stores only the hash, never the plaintext token", () => {
  const dataDir = dir();
  const { mintedToken } = loadOperatorRegistry(dataDir);
  const contents = readFileSync(join(dataDir, "operators.json"), "utf-8");
  assert.ok(!contents.includes(mintedToken!), "operators.json must not contain the plaintext token");
});

test("writes operators.json 0600", () => {
  const dataDir = dir();
  loadOperatorRegistry(dataDir);
  assert.equal(statSync(join(dataDir, "operators.json")).mode & 0o777, 0o600);
});

test("does not re-mint on a second load", () => {
  const dataDir = dir();
  const first = loadOperatorRegistry(dataDir);
  const second = loadOperatorRegistry(dataDir);
  assert.equal(second.mintedToken, undefined);
  assert.equal(second.registry.resolve(first.mintedToken), LEGACY_OPERATOR_NAME);
});

test("adopts a pre-existing plaintext operator.token instead of invalidating it", () => {
  const dataDir = dir();
  writeFileSync(join(dataDir, "operator.token"), "legacy-token-value\n", { mode: 0o600 });

  const { registry, mintedToken } = loadOperatorRegistry(dataDir);
  assert.equal(mintedToken, undefined, "an existing deployment's token must keep working, not be replaced");
  assert.equal(registry.resolve("legacy-token-value"), LEGACY_OPERATOR_NAME);
  assert.ok(existsSync(join(dataDir, "operator.token")), "the legacy file must not be deleted out from under a running server");
});

test("named operators resolve to their own names", () => {
  const dataDir = dir();
  loadOperatorRegistry(dataDir);
  const aliceToken = addOperator(dataDir, "alice");
  const bobToken = addOperator(dataDir, "bob");

  const { registry } = loadOperatorRegistry(dataDir);
  assert.equal(registry.resolve(aliceToken), "alice");
  assert.equal(registry.resolve(bobToken), "bob");
  assert.deepEqual(registry.names().sort(), ["alice", "bob", LEGACY_OPERATOR_NAME].sort());
});

test("rejects an unknown token and an absent one", () => {
  const dataDir = dir();
  const { registry } = loadOperatorRegistry(dataDir);
  assert.equal(registry.resolve("not-a-real-token"), undefined);
  assert.equal(registry.resolve(undefined), undefined);
  assert.equal(registry.resolve(""), undefined);
});

test("refuses a duplicate operator name", () => {
  const dataDir = dir();
  addOperator(dataDir, "alice");
  assert.throws(() => addOperator(dataDir, "alice"), /already exists/);
});

test("refuses an empty operator name", () => {
  assert.throws(() => addOperator(dir(), "   "), /name is required/);
});

test("throws on an unparseable operators.json rather than silently locking everyone out", () => {
  const dataDir = dir();
  writeFileSync(join(dataDir, "operators.json"), "{ not json", { mode: 0o600 });
  // Failing loudly matters: an empty registry would reject every token, which
  // looks exactly like a wrong token and sends the operator hunting the wrong bug.
  assert.throws(() => loadOperatorRegistry(dataDir), /could not parse/);
});

test("singleTokenRegistry resolves its one token and nothing else", () => {
  const registry = singleTokenRegistry("shared-secret");
  assert.equal(registry.resolve("shared-secret"), LEGACY_OPERATOR_NAME);
  assert.equal(registry.resolve("shared-secre"), undefined);
});
