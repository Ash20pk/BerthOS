import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileAuditSink, createMemoryAuditSink, readAuditFile, verifyAuditChain, type Actor, type AuditSink } from "@berthos/audit";
import type { BootEvidence } from "@berthos/docker-orchestrator";
import { createRunAudit, newRunId, recordedBootEvidence, SANDBOX_BOOT_ACTION, TOOL_CALL_ACTION } from "./run-audit.js";

const actor: Actor = { kind: "agent", id: "test-client", verifiedBy: "self-asserted" };
const operator: Actor = { kind: "operator", id: "alice", verifiedBy: "self-asserted" };

const evidence: BootEvidence = {
  bootId: "boot-1",
  containerName: "berth-dev-filesystem",
  imageTag: "berth/filesystem:dev",
  imageDigest: "sha256:" + "a".repeat(64),
  rulesetReports: [{ app: "filesystem", ruleset: "FullyEnforced", bootId: "boot-1" }],
  policies: [{ app: "filesystem", path: "/app/capability-policy.json", sha256: "b".repeat(64) }],
  doctorProbe: { status: "enforcing" },
};

function runAuditFor(sink: AuditSink) {
  return createRunAudit({ sink, runId: "run-1", app: "filesystem", containerName: "berth-dev-filesystem", via: "mcp", actor: () => actor, operator });
}

function audit() {
  const sink = createMemoryAuditSink();
  return { sink, run: runAuditFor(sink) };
}

test("newRunId names the app and is unique per call", () => {
  const at = new Date("2026-09-28T10:15:00.123Z");
  const a = newRunId("filesystem", at);
  assert.match(a, /^mcp-filesystem-20260928T101500Z-[0-9a-f]{6}$/);
  assert.notEqual(a, newRunId("filesystem", at));
});

test("a successful call is recorded as allowed, tagged with the run id", async () => {
  const { sink, run } = audit();
  await run.toolCall({ export: "read_file", input: { path: "/workspace/a" }, durationMs: 4, result: { content: "hi" } });

  const [record] = sink.records;
  assert.equal(record!.action, TOOL_CALL_ACTION);
  assert.equal(record!.target, "filesystem.read_file");
  assert.equal(record!.decision, "allowed");
  assert.equal(record!.reason, undefined);
  assert.deepEqual(record!.meta, { runId: "run-1", via: "mcp", container: "berth-dev-filesystem" });
  assert.deepEqual(record!.actor, actor);
});

test("a sandbox refusal is denied; an app error is an allowed call that failed", async () => {
  const { sink, run } = audit();
  await run.toolCall({ export: "write_file", input: {}, durationMs: 2, error: "EACCES: permission denied, open '/etc/x'", denied: true });
  await run.toolCall({ export: "write_file", input: {}, durationMs: 2, error: "TypeError: x is undefined" });

  const [denied, failed] = sink.records;
  assert.equal(denied!.decision, "denied");
  assert.equal(denied!.reason, "EACCES: permission denied, open '/etc/x'");
  assert.equal((denied!.meta as { failed?: boolean }).failed, undefined);
  assert.equal(failed!.decision, "allowed");
  assert.equal((failed!.meta as { failed?: boolean }).failed, true);
});

// The file sink is what `berth mcp` uses: payloads stay off disk unless asked
// for, and the evidence survives the trip through redaction and the chain.
test("through the file sink, payloads are dropped and the boot evidence reads back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "berth-run-audit-"));
  try {
    const path = join(dir, "audit.jsonl");
    const run = runAuditFor(createFileAuditSink({ path }));
    await run.sandboxBoot(evidence);
    await run.toolCall({ export: "read_file", input: { path: "/workspace/secret-plans" }, durationMs: 1, result: { content: "plans" } });

    const records = readAuditFile(path);
    assert.equal(verifyAuditChain(records).valid, true);
    assert.equal(records[0]!.action, SANDBOX_BOOT_ACTION);
    assert.deepEqual(records[0]!.actor, operator);
    assert.equal(records[1]!.input, undefined);
    assert.equal(records[1]!.output, undefined);
    assert.deepEqual(recordedBootEvidence(records), evidence);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordedBootEvidence takes the latest boot and ignores malformed ones", async () => {
  const { sink, run } = audit();
  assert.equal(recordedBootEvidence(sink.records), undefined);

  await run.sandboxBoot(evidence);
  await run.sandboxBoot({ ...evidence, bootId: "boot-2" });
  await sink.record({ ts: "", seq: 0, actor, action: SANDBOX_BOOT_ACTION, decision: "allowed", meta: { runId: "run-1", evidence: { bootId: "x" } } });

  assert.equal(recordedBootEvidence(sink.records)?.bootId, "boot-2");
});

test("refusals inside a call that succeeded are recorded, and the call stays allowed", async () => {
  const { sink, run } = audit();
  await run.toolCall({
    export: "run_code",
    input: {},
    durationMs: 3,
    result: { exit_code: 0 },
    innerDenials: ["PermissionError: [Errno 13] Permission denied: '/etc/x'"],
  });
  const [record] = sink.records;
  assert.equal(record!.decision, "allowed");
  assert.match(record!.reason!, /refused 1 operation\(s\) inside the call: PermissionError/);
  assert.deepEqual((record!.meta as { denials?: string[] }).denials, ["PermissionError: [Errno 13] Permission denied: '/etc/x'"]);
});
