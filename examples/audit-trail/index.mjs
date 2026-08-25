#!/usr/bin/env node
/**
 * The audit trail catches an edit — and admits what it can't catch.
 *
 * The third leg of IAM, after "declare" and "enforce", is "prove". Berth's
 * audit trail is a hash-chained JSONL file: each record commits to the one
 * before it, so changing any past record breaks every hash after it, and a
 * third party can recompute the whole chain without trusting the process that
 * wrote it.
 *
 * This demo needs no Docker and no kernel — it's about the record, not the
 * sandbox. It:
 *   1. writes a handful of realistic audit records (an allowed call, a denied
 *      one, a grant approval),
 *   2. verifies the chain — VALID,
 *   3. tampers with one record on disk the way an attacker covering their
 *      tracks would (flip a "denied" to "allowed"), and re-verifies — BROKEN,
 *      pointing at the exact record,
 *   4. then does the honest part: rewrites the chain *properly* from the
 *      tampered record forward, and shows it now verifies again — because
 *      anyone who can write the file can recompute it. Tamper-evident, not
 *      tamper-proof, and the demo says so to your face.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  CHAIN_GENESIS,
  canonicalize,
  createFileAuditSink,
  readAuditFile,
  verifyAuditChain,
  operatorActor,
  agentActor,
  appActor,
} from "@berth/audit";

const auditPath = join(mkdtempSync(join(tmpdir(), "berth-audit-")), "audit.jsonl");
const sink = createFileAuditSink({ path: auditPath });

// --- 1. a realistic run's worth of events -----------------------------------
await sink.record({ ts: new Date().toISOString(), seq: 0, actor: agentActor("assistant"), action: "agent.tool-call", target: "filesystem/write_file", decision: "allowed" });
await sink.record({ ts: new Date().toISOString(), seq: 0, actor: agentActor("assistant"), action: "agent.tool-call", target: "filesystem/write_file", decision: "denied", reason: "path /etc/cron.d/pwned outside declared filesystem:write scope" });
await sink.record({ ts: new Date().toISOString(), seq: 0, actor: appActor("github-assistant", "peer-socket"), action: "http.request", target: "api.github.com/issues", decision: "allowed" });
await sink.record({ ts: new Date().toISOString(), seq: 0, actor: operatorActor("aswin"), action: "grant.approve", target: "grant-7f3a", decision: "allowed" });

console.log(`wrote ${readAuditFile(auditPath).length} hash-chained records to ${auditPath}\n`);

// --- 2. verify a clean chain ------------------------------------------------
const clean = verifyAuditChain(readAuditFile(auditPath));
console.log(`--- clean chain ---`);
console.log(`verification: ${clean.valid ? "VALID" : `BROKEN at ${clean.brokenAt}`}\n`);

// --- 3. tamper: an attacker flips their own denial to "allowed" --------------
const lines = readFileSync(auditPath, "utf-8").split("\n").filter(Boolean);
const target = JSON.parse(lines[1]);
console.log(`--- tampering ---`);
console.log(`attacker edits record 1: decision "${target.decision}" -> "allowed", drops the reason`);
target.decision = "allowed";
delete target.reason;
lines[1] = JSON.stringify(target); // written back WITHOUT recomputing hashes
writeFileSync(auditPath, lines.join("\n") + "\n");

const tampered = verifyAuditChain(readAuditFile(auditPath));
console.log(`verification: ${tampered.valid ? "VALID" : `BROKEN at record ${tampered.brokenAt}`}`);
console.log(`reason: ${tampered.reason}\n`);

// --- 4. the honest limit: a full rewrite restores validity ------------------
console.log(`--- the honest part: tamper-evident, not tamper-proof ---`);
const records = readAuditFile(auditPath);
let prev = CHAIN_GENESIS;
const rewritten = records.map((r) => {
  const { prevHash, hash, ...event } = r;
  const newHash = createHash("sha256").update(prev).update(canonicalize(event)).digest("hex");
  const rebuilt = { ...event, prevHash: prev, hash: newHash };
  prev = newHash;
  return rebuilt;
});
writeFileSync(auditPath, rewritten.map((r) => JSON.stringify(r)).join("\n") + "\n");
const rewrittenCheck = verifyAuditChain(readAuditFile(auditPath));
console.log(`after recomputing every hash from the edit forward: ${rewrittenCheck.valid ? "VALID again" : "still broken"}`);
console.log(
  "\nThat is the whole claim, stated honestly: anyone who can write the file can\n" +
    "recompute the chain, so this does not stop a full rewrite. What it stops is a\n" +
    "*partial* edit — flipping one record without touching the rest — which is what\n" +
    "covering-your-tracks actually looks like. For tamper-PROOF you ship each record's\n" +
    "hash somewhere the attacker can't rewrite (a WORM log, a notary); the chain is\n" +
    "what makes that cheap, since you only pin the latest hash, not every record.",
);

if (clean.valid && !tampered.valid && tampered.brokenAt === 1 && rewrittenCheck.valid) {
  console.log("\nPASS — clean verified, a single-record edit was caught at exactly record 1, and the\n" +
    "documented full-rewrite limit holds. The record behaves as the trust model claims.");
} else {
  console.error("\nFAIL — the chain did not behave as documented.");
  process.exitCode = 1;
}
