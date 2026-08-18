import { strict as assert } from "node:assert";
import { test } from "node:test";
import { redact, REDACTED } from "./redact.js";

test("replaces secret-looking keys at any depth", () => {
  const out = redact({
    path: "/workspace/a.txt",
    apiKey: "sk-live-abc",
    nested: { ANTHROPIC_API_KEY: "sk-ant", password: "hunter2", keep: 1 },
  }) as Record<string, any>;

  assert.equal(out.path, "/workspace/a.txt");
  assert.equal(out.apiKey, REDACTED);
  assert.equal(out.nested.ANTHROPIC_API_KEY, REDACTED);
  assert.equal(out.nested.password, REDACTED);
  assert.equal(out.nested.keep, 1);
});

test("matches secret keys case- and separator-insensitively", () => {
  const out = redact({ "x-api-key": "a", "Authorization": "b", "Session Token": "c" }) as Record<string, unknown>;
  assert.equal(out["x-api-key"], REDACTED);
  assert.equal(out["Authorization"], REDACTED);
  assert.equal(out["Session Token"], REDACTED);
});

test("truncates an oversized string to a marker rather than a prefix", () => {
  const out = redact({ blob: "x".repeat(5000) }) as Record<string, string>;
  const blob = out.blob!;
  // A prefix of a credential is still a credential — the marker must not contain the value.
  assert.match(blob, /^<[\d.]+KB string, not captured>$/);
  assert.ok(!blob.includes("xxx"));
});

test("caps arrays and says how many were dropped", () => {
  const out = redact(Array.from({ length: 60 }, (_, i) => i), { maxArrayLength: 10 }) as unknown[];
  assert.equal(out.length, 11);
  assert.equal(out[10], "<50 more items>");
});

test("survives a circular reference", () => {
  const node: Record<string, unknown> = { name: "a" };
  node.self = node;
  const out = redact(node) as Record<string, unknown>;
  assert.equal(out.name, "a");
  assert.equal(out.self, "<circular>");
});

test("describes values JSON can't carry instead of dropping them", () => {
  const out = redact({
    when: new Date("2026-01-01T00:00:00.000Z"),
    err: new Error("boom"),
    buf: Buffer.alloc(2048),
    fn: () => 1,
    big: 10n,
  }) as Record<string, any>;

  assert.equal(out.when, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(out.err, { name: "Error", message: "boom" });
  assert.equal(out.buf, "<2.0KB buffer, not captured>");
  assert.equal(out.fn, "<function>");
  assert.equal(out.big, "10n");
});

test("stops at max depth rather than recursing forever", () => {
  let deep: Record<string, unknown> = { end: true };
  for (let i = 0; i < 20; i++) deep = { next: deep };
  const json = JSON.stringify(redact(deep));
  assert.ok(json.includes("<max depth>"));
});

test("honours additionalSecretKeys", () => {
  const out = redact({ ssn: "123-45-6789" }, { additionalSecretKeys: ["ssn"] }) as Record<string, unknown>;
  assert.equal(out.ssn, REDACTED);
});
