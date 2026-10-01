import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attestationDigest,
  deriveEnforcementStatus,
  finalizeAttestation,
  verifyAttestation,
  type AttestationInput,
} from "./attest.js";

function baseInput(overrides: Partial<AttestationInput> = {}): AttestationInput {
  return {
    generatedAt: "2026-08-23T00:00:00.000Z",
    runId: "run-1",
    run: { records: 3, firstSeq: 10, lastSeq: 12, firstTs: "2026-08-23T00:00:00.000Z", lastTs: "2026-08-23T00:00:01.000Z" },
    auditChain: { path: "/home/x/.berth/audit/audit.jsonl", segments: 1, totalRecords: 40, head: "a".repeat(64) },
    boot: { bootId: "boot-uuid", containerName: "berth-os-demo", imageTag: "berth/demo:latest", imageDigest: "sha256:" + "b".repeat(64) },
    enforcement: {
      rulesetReports: [{ app: "demo", ruleset: "FullyEnforced", bootId: "boot-uuid", timestamp: 1 }],
      doctorProbe: { status: "enforcing" },
    },
    policies: [{ app: "demo", path: "/app/.berth/capability-policy.json", sha256: "c".repeat(64) }],
    ...overrides,
  };
}

describe("deriveEnforcementStatus", () => {
  it("is ACTIVE only when the probe enforces and every report is FullyEnforced", () => {
    assert.equal(deriveEnforcementStatus([{ app: "a", ruleset: "FullyEnforced", bootId: "b" }], { status: "enforcing" }).status, "ACTIVE");
  });

  it("any non-FullyEnforced report means NOT_ENFORCED, with the app named", () => {
    const r = deriveEnforcementStatus(
      [
        { app: "a", ruleset: "FullyEnforced", bootId: "b" },
        { app: "c", ruleset: "NotEnforced", bootId: "b" },
      ],
      { status: "enforcing" },
    );
    assert.equal(r.status, "NOT_ENFORCED");
    assert.ok(r.reasons.some((x) => x.includes('"c"')));
  });

  it("a probe that found no enforcement means NOT_ENFORCED even if agent-init claims otherwise", () => {
    const r = deriveEnforcementStatus([{ app: "a", ruleset: "FullyEnforced", bootId: "b" }], { status: "unsupported", reason: "no landlock" });
    assert.equal(r.status, "NOT_ENFORCED");
  });

  it("missing measurements are UNDETERMINED, never ACTIVE", () => {
    assert.equal(deriveEnforcementStatus([], { status: "enforcing" }).status, "UNDETERMINED");
    assert.equal(deriveEnforcementStatus([{ app: "a", ruleset: "FullyEnforced", bootId: "b" }], { status: "unknown" }).status, "UNDETERMINED");
  });
});

describe("finalizeAttestation + verifyAttestation", () => {
  it("a finalized record verifies", () => {
    const record = finalizeAttestation(baseInput());
    assert.equal(record.enforcement.status, "ACTIVE");
    assert.ok(record.trustModel.includes("tamper-evident"));
    const v = verifyAttestation(record);
    assert.deepEqual(v, { valid: true, problems: [] });
  });

  it("editing any field after emission breaks the self-hash", () => {
    const record = finalizeAttestation(baseInput());
    const edited = { ...record, boot: { ...record.boot, imageDigest: "sha256:" + "d".repeat(64) } };
    const v = verifyAttestation(edited);
    assert.equal(v.valid, false);
    assert.ok(v.problems.some((p) => p.message.includes("recordSha256")));
  });

  it("upgrading the verdict is caught even when the editor recomputes the self-hash", () => {
    const record = finalizeAttestation(
      baseInput({ enforcement: { rulesetReports: [{ app: "demo", ruleset: "NotEnforced", bootId: "boot-uuid" }], doctorProbe: { status: "unsupported" } } }),
    );
    assert.equal(record.enforcement.status, "NOT_ENFORCED");
    const forged = { ...record, enforcement: { ...record.enforcement, status: "ACTIVE" as const } };
    forged.recordSha256 = attestationDigest(forged);
    const v = verifyAttestation(forged);
    assert.equal(v.valid, false);
    assert.ok(v.problems.some((p) => p.message.includes("edited independently of its evidence")));
  });

  it("a record with no run evidence is rejected", () => {
    const record = finalizeAttestation(baseInput({ run: { records: 0 } }));
    const v = verifyAttestation(record);
    assert.equal(v.valid, false);
    assert.ok(v.problems.some((p) => p.message.includes("run.records")));
  });
});

describe("boot.isolation (microVM extension)", () => {
  const isolation = {
    kind: "microvm" as const,
    engine: "libkrun",
    hypervisor: "hvf",
    kernel: { sha256: "8".repeat(64), pinned: true, linux: "6.12.109" },
    rootfs: { sha256: "5".repeat(64), pinned: true, fstype: "erofs" },
    tsi: false,
    nics: 0,
  };

  it("a record carrying it verifies, and the field is inside the digest", () => {
    const base = baseInput();
    const record = finalizeAttestation({ ...base, boot: { ...base.boot, isolation } });
    assert.equal(verifyAttestation(record).valid, true);
    const tampered = { ...record, boot: { ...record.boot, isolation: { ...isolation, nics: 1 } } };
    assert.equal(verifyAttestation(tampered).valid, false);
    assert.notEqual(record.recordSha256, finalizeAttestation(base).recordSha256);
  });

  it("never changes the verdict", () => {
    const base = baseInput({ enforcement: { rulesetReports: [], doctorProbe: { status: "enforcing" } } });
    const record = finalizeAttestation({ ...base, boot: { ...base.boot, isolation } });
    assert.equal(record.enforcement.status, "UNDETERMINED");
  });
});
