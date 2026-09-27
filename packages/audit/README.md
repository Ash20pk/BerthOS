# @berthos/audit

Hash-chained audit records: write them to a file, verify the chain, redact payloads, and verify attestation records.

[Berth](https://github.com/Ash20pk/BerthOS) runs an AI agent's tools in a sandbox. Each tool declares what it may touch in a `berth.yml` manifest, and the Linux kernel enforces it.

```sh
npm install @berthos/audit
```

## Usage

```ts
import { createFileAuditSink, readAuditFile, verifyAuditChain, agentActor } from "@berthos/audit";

const sink = createFileAuditSink({ path: "audit.jsonl" });
await sink.record({
  ts: new Date().toISOString(),
  seq: 0, // the sink assigns the real sequence number
  actor: agentActor("assistant"),
  action: "agent.tool-call",
  target: "filesystem/write_file",
  decision: "denied",
  reason: "path outside declared filesystem:write scope",
});

const result = verifyAuditChain(readAuditFile("audit.jsonl"));
console.log(result.valid ? "VALID" : `BROKEN at record ${result.brokenAt}`);
```

Each record commits to the one before it, so an edited record breaks the chain at that record. Someone who can rewrite the whole file can recompute the chain, so it is tamper-evident, not tamper-proof: pin the latest hash somewhere an attacker can't write if you need more.

Also exported: `redact()`, `verifyAuditSegments()` for rotated files, memory and console sinks, and `verifyAttestation()` for records from `berth attest`.

## Docs

[Audit reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/audit-reference.md) · [Attestation reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/attestation-reference.md) · [Repo](https://github.com/Ash20pk/BerthOS)
