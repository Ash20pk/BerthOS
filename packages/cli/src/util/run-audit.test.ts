import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileAuditSink, createMemoryAuditSink, readAuditFile, verifyAuditChain, type Actor, type AuditSink } from "@berthos/audit";
import type { BootEvidence } from "@berthos/docker-orchestrator";
import { auditReason, createRunAudit, MAX_REASON_CHARS, newRunId, recordedBootEvidence, SANDBOX_BOOT_ACTION, TOOL_CALL_ACTION } from "./run-audit.js";

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

function runAuditFor(sink: AuditSink, sessionId = "bridge-a") {
  return createRunAudit({ sink, runId: "run-1", sessionId, app: "filesystem", containerName: "berth-dev-filesystem", via: "mcp", actor: () => actor, operator });
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
  assert.deepEqual(record!.meta, { runId: "run-1", bridge: "bridge-a", via: "mcp", container: "berth-dev-filesystem" });
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
    assert.deepEqual(recordedBootEvidence(records), { evidence });
    // The sink redacts meta keys that look like secrets ("session" is one);
    // the bridge id has to survive it to bind calls to their boot.
    assert.equal((records[1]!.meta as { bridge?: string }).bridge, "bridge-a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordedBootEvidence takes a session's latest boot and ignores malformed ones", async () => {
  const { sink, run } = audit();
  assert.equal(recordedBootEvidence(sink.records), undefined);

  await run.sandboxBoot({ ...evidence, doctorProbe: { status: "unknown" } });
  await run.sandboxBoot(evidence);
  await sink.record({ ts: "", seq: 0, actor, action: SANDBOX_BOOT_ACTION, decision: "allowed", meta: { runId: "run-1", bridge: "bridge-a", evidence: { bootId: "x" } } });

  assert.deepEqual(recordedBootEvidence(sink.records), { evidence });
});

// A reused --run-id used to be attested against whichever boot came last,
// including for calls that ran in an earlier, different boot.
test("a run reused across sessions in different boots is refused, not attested against the latest", async () => {
  const sink = createMemoryAuditSink();
  const first = runAuditFor(sink, "bridge-a");
  const second = runAuditFor(sink, "bridge-b");
  await first.sandboxBoot(evidence);
  await first.toolCall({ export: "read_file", input: {}, durationMs: 1, result: {} });
  await second.sandboxBoot({ ...evidence, bootId: "boot-2" });
  await second.toolCall({ export: "read_file", input: {}, durationMs: 1, result: {} });

  const recorded = recordedBootEvidence(sink.records);
  assert.ok(recorded && "problem" in recorded);
  assert.match(recorded.problem, /spans 2 boots \(boot-1, boot-2\)/);
});

test("sessions that attached to the same boot attest together", async () => {
  const sink = createMemoryAuditSink();
  const first = runAuditFor(sink, "bridge-a");
  const second = runAuditFor(sink, "bridge-b");
  await first.sandboxBoot(evidence);
  await first.toolCall({ export: "read_file", input: {}, durationMs: 1, result: {} });
  await second.sandboxBoot({ ...evidence, doctorProbe: { status: "enforcing", detail: "re-probed" } as BootEvidence["doctorProbe"] });
  await second.toolCall({ export: "read_file", input: {}, durationMs: 1, result: {} });

  const recorded = recordedBootEvidence(sink.records);
  assert.ok(recorded && "evidence" in recorded);
  assert.equal(recorded.evidence.bootId, "boot-1");
});

test("a session whose calls have no recorded boot is not covered by another session's", async () => {
  const sink = createMemoryAuditSink();
  const first = runAuditFor(sink, "bridge-a");
  const second = runAuditFor(sink, "bridge-b");
  await first.sandboxBoot(evidence);
  await second.toolCall({ export: "read_file", input: {}, durationMs: 1, result: {} });

  const recorded = recordedBootEvidence(sink.records);
  assert.ok(recorded && "problem" in recorded);
  assert.match(recorded.problem, /session\(s\) bridge-b have no recorded boot evidence/);
});

test("a boot record naming a different container than its session's calls is refused", async () => {
  const { sink, run } = audit();
  await run.sandboxBoot({ ...evidence, containerName: "berth-dev-other" });
  const recorded = recordedBootEvidence(sink.records);
  assert.ok(recorded && "problem" in recorded);
  assert.match(recorded.problem, /"berth-dev-other" but its calls went to "berth-dev-filesystem"/);
});

// A call the app never answered used to leave no record at all.
test("a call with no answer is recorded as allowed, failed, and of unknown outcome", async () => {
  const { sink, run } = audit();
  await run.toolCall({ export: "write_file", input: {}, durationMs: 30_000, unanswered: { reason: "timed out after 30s waiting for RPC response" } });
  await run.toolCall({ export: "write_file", input: {}, durationMs: 5, unanswered: { reason: "the session ended", interrupted: true } });

  const [timedOut, interrupted] = sink.records;
  assert.equal(timedOut!.decision, "allowed");
  assert.match(timedOut!.reason!, /^no answer from the app: timed out after 30s .* — the call may have run$/);
  assert.deepEqual(
    { failed: (timedOut!.meta as Record<string, unknown>).failed, outcome: (timedOut!.meta as Record<string, unknown>).outcome },
    { failed: true, outcome: "unknown" },
  );
  assert.equal(timedOut!.output, undefined);
  assert.match(interrupted!.reason!, /session ended before the app answered/);
  assert.equal((interrupted!.meta as { interrupted?: boolean }).interrupted, true);
});

// The app's raw error is written even though inputs and outputs are not, and
// it can carry both: a stack, the payload it choked on, file contents.
test("an app error's reason is its first line, capped", async () => {
  const { sink, run } = audit();
  const long = `Error: bad input ${"x".repeat(1000)}`;
  await run.toolCall({ export: "write_file", input: {}, durationMs: 2, error: `${long}\n    at handler (/app/index.js:1:1)\ncontents: s3cr3t` });

  const reason = sink.records[0]!.reason!;
  assert.ok(reason.startsWith("Error: bad input xxx"));
  assert.ok(!reason.includes("s3cr3t") && !reason.includes("at handler"));
  assert.match(reason, /… \(\d+ more chars not recorded\)$/);
  assert.ok(reason.length < MAX_REASON_CHARS + 50);
  assert.equal(auditReason("EACCES: permission denied, open '/etc/x'"), "EACCES: permission denied, open '/etc/x'");
  assert.equal(auditReason("a\u001b[31mb"), "a [31mb");
});

// Only the count and paths: the lines they came from are the call's output,
// and a record written with payload capture off must not carry output.
test("possible refusals inside a call that succeeded are recorded as a count and paths, and the call stays allowed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "berth-run-audit-"));
  try {
    const path = join(dir, "audit.jsonl");
    const run = runAuditFor(createFileAuditSink({ path }));
    await run.toolCall({
      export: "run_code",
      input: {},
      durationMs: 3,
      result: { stdout: "secret output\nPermissionError: [Errno 13] Permission denied: '/etc/x'", exit_code: 0 },
      reportedDeniedPaths: ["/etc/x"],
    });
    const [record] = readAuditFile(path);
    assert.equal(record!.decision, "allowed");
    assert.equal(record!.reason, "the app reported 1 possible sandbox refusal(s) inside the call");
    const meta = record!.meta as { reportedDenials?: number; reportedDeniedPaths?: string[] };
    assert.equal(meta.reportedDenials, 1);
    assert.deepEqual(meta.reportedDeniedPaths, ["/etc/x"]);
    assert.ok(!JSON.stringify(record).includes("secret output"));
    assert.ok(!JSON.stringify(record).includes("PermissionError"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
