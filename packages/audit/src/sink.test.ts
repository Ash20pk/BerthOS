import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAIN_GENESIS,
  combineAuditSinks,
  createFileAuditSink,
  createMemoryAuditSink,
  readAuditFile,
  verifyAuditChain,
} from "./sink.js";
import { operatorActor } from "./index.js";
import { REDACTED } from "./redact.js";
import type { AuditEvent } from "./types.js";

function tmp(): string {
  return join(mkdtempSync(join(tmpdir(), "berth-audit-")), "audit.jsonl");
}

function denial(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    ts: "2026-08-16T00:00:00.000Z",
    seq: 0,
    actor: operatorActor("alice"),
    action: "governance.evaluate",
    target: "filesystem.write_file",
    decision: "denied",
    reason: "path outside the declared capability",
    ...overrides,
  };
}

test("writes one JSON object per line, parseable with no prefix stripping", async () => {
  const path = tmp();
  const sink = createFileAuditSink({ path });
  await sink.record(denial());
  await sink.record(denial({ decision: "allowed", reason: undefined }));

  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  assert.equal(JSON.parse(lines[0]!).decision, "denied");
});

test("creates the file 0600", async () => {
  const path = tmp();
  await createFileAuditSink({ path }).record(denial());
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("tightens the mode of a pre-existing world-readable file", async () => {
  const path = tmp();
  writeFileSync(path, "", { mode: 0o644 });
  await createFileAuditSink({ path }).record(denial());
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("assigns monotonic seq numbers, overriding whatever the caller passed", async () => {
  const path = tmp();
  const sink = createFileAuditSink({ path });
  await sink.record(denial({ seq: 99 }));
  await sink.record(denial({ seq: 99 }));
  const records = readAuditFile(path);
  assert.deepEqual(records.map((r) => r.seq), [0, 1]);
});

test("chains hashes from genesis and verifies", async () => {
  const path = tmp();
  const sink = createFileAuditSink({ path });
  for (let i = 0; i < 5; i++) await sink.record(denial({ target: `app.export${i}` }));

  const records = readAuditFile(path);
  assert.equal(records[0]!.prevHash, CHAIN_GENESIS);
  assert.equal(records[1]!.prevHash, records[0]!.hash);

  const result = verifyAuditChain(records);
  assert.equal(result.valid, true);
  assert.equal(result.brokenAt, -1);
});

test("detects an edited record", async () => {
  const path = tmp();
  const sink = createFileAuditSink({ path });
  for (let i = 0; i < 4; i++) await sink.record(denial({ target: `app.export${i}` }));

  const records = readAuditFile(path);
  records[2]!.decision = "allowed"; // the tamper an operator covering their tracks would make

  const result = verifyAuditChain(records);
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 2);
  assert.match(result.reason!, /do not match its hash/);
});

test("detects a deleted record", async () => {
  const path = tmp();
  const sink = createFileAuditSink({ path });
  for (let i = 0; i < 4; i++) await sink.record(denial({ target: `app.export${i}` }));

  const records = readAuditFile(path);
  records.splice(1, 1);

  const result = verifyAuditChain(records);
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 1);
  assert.match(result.reason!, /does not match the previous record/);
});

test("resumes the chain across a restart instead of starting a new one", async () => {
  const path = tmp();
  const first = createFileAuditSink({ path });
  await first.record(denial());
  await first.record(denial());

  const second = createFileAuditSink({ path }); // fresh process would do exactly this
  await second.record(denial());

  const records = readAuditFile(path);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((r) => r.seq), [0, 1, 2]);
  assert.equal(verifyAuditChain(records).valid, true);
});

test("resumes past a torn final line", async () => {
  const path = tmp();
  const sink = createFileAuditSink({ path });
  await sink.record(denial());
  const good = readAuditFile(path)[0]!;
  writeFileSync(path, `${JSON.stringify(good)}\n{"ts":"2026`, { mode: 0o600 });

  await createFileAuditSink({ path }).record(denial());
  const records = readAuditFile(path); // readAuditFile drops the torn line
  assert.equal(records.length, 2);
  assert.equal(records[1]!.prevHash, good.hash);
});

test("omits payloads unless capture is enabled", async () => {
  const path = tmp();
  await createFileAuditSink({ path }).record(denial({ input: { path: "/w/a.txt" }, output: "contents" }));
  const record = readAuditFile(path)[0]!;
  assert.equal(record.input, undefined);
  assert.equal(record.output, undefined);
});

test("captures and redacts payloads when enabled", async () => {
  const path = tmp();
  await createFileAuditSink({ path, capturePayloads: true }).record(
    denial({ input: { path: "/w/a.txt", apiKey: "sk-live" }, output: "ok" }),
  );
  const record = readAuditFile(path)[0]!;
  assert.deepEqual(record.input, { path: "/w/a.txt", apiKey: REDACTED });
  assert.equal(record.output, "ok");
});

test("redacts meta even when payload capture is off", async () => {
  const path = tmp();
  await createFileAuditSink({ path }).record(denial({ meta: { requestId: "r1", token: "shh" } }));
  const record = readAuditFile(path)[0]!;
  assert.deepEqual(record.meta, { requestId: "r1", token: REDACTED });
});

test("a captured payload still verifies — redaction happens before hashing", async () => {
  const path = tmp();
  const sink = createFileAuditSink({ path, capturePayloads: true });
  await sink.record(denial({ input: { password: "hunter2" } }));
  await sink.record(denial({ input: { ok: true } }));
  assert.equal(verifyAuditChain(readAuditFile(path)).valid, true);
});

test("rotates at maxBytes and carries the chain into the new file", async () => {
  const path = tmp();
  // Sized so exactly one rotation happens: each record is ~350B, so the
  // first file crosses 1200B partway through and the remainder stays under it.
  const sink = createFileAuditSink({ path, maxBytes: 1200, maxFiles: 3 });
  for (let i = 0; i < 6; i++) await sink.record(denial({ target: `app.export${i}` }));

  const rotated = readAuditFile(`${path}.1`);
  const current = readAuditFile(path);
  assert.ok(rotated.length > 0, "expected a rotated file");
  assert.ok(current.length > 0);

  const first = verifyAuditChain(rotated);
  assert.equal(first.valid, true);
  // The chain must span the rotation boundary, or half the trail is unverifiable.
  assert.equal(current[0]!.prevHash, first.endHash);
  assert.equal(verifyAuditChain(current, first.endHash).valid, true);
});

test("keeps at most maxFiles rotated files", async () => {
  const path = tmp();
  const sink = createFileAuditSink({ path, maxBytes: 512, maxFiles: 2 });
  for (let i = 0; i < 200; i++) await sink.record(denial({ target: `app.export${i}` }));
  assert.ok(readAuditFile(`${path}.2`).length > 0);
  assert.equal(readAuditFile(`${path}.3`).length, 0, "expected .3 to have been pruned");
});

test("a sink that can't write reports and does not throw", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (msg: unknown) => void errors.push(String(msg));
  try {
    // A directory where the file should be: every write fails, nothing throws.
    const dir = mkdtempSync(join(tmpdir(), "berth-audit-"));
    const sink = createFileAuditSink({ path: join(dir, "sub") });
    mkdirSync(join(dir, "sub"), { recursive: true });
    await sink.record(denial());
  } finally {
    console.error = original;
  }
  assert.ok(errors.some((e) => e.includes("[berth-audit]")));
});

test("memory sink chains the same way", async () => {
  const sink = createMemoryAuditSink();
  await sink.record(denial());
  await sink.record(denial());
  assert.equal(verifyAuditChain(sink.records).valid, true);
});

test("combineAuditSinks fans out and survives one sink failing", async () => {
  const good = createMemoryAuditSink();
  const bad = { record: async () => { throw new Error("backend down"); } };
  const errors: string[] = [];
  const original = console.error;
  console.error = (msg: unknown) => void errors.push(String(msg));
  try {
    await combineAuditSinks(bad, good).record(denial());
  } finally {
    console.error = original;
  }
  assert.equal(good.records.length, 1);
  assert.ok(errors.some((e) => e.includes("an audit sink failed")));
});
