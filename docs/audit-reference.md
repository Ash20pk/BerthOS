# Audit trail reference

`@berth/audit` is the record of what happened on a Berth installation and who did it: governance verdicts, capability-grant decisions, failed authentication attempts, and — optionally — every step an agent took.

It exists because none of that was written down. `REMEDIATION.md` 5.1: governance denials threw silently, no server logged a request, `AgentStepEvent` recorded tool names and no actor, and `decided_by` on a grant was free text from the request body. A gate that blocks a hundred calls used to leave exactly the same trace as a gate nobody ever consulted.

## What a record looks like

One JSON object per line, hash-chained, written 0600:

```json
{"ts":"2026-08-16T09:14:22.104Z","seq":41,"actor":{"kind":"operator","id":"alice","verifiedBy":"token"},"action":"grant.approve","target":"grant:9f2a…","decision":"allowed","meta":{"appName":"browser-native","capability":"network:connect:443"},"prevHash":"…","hash":"…"}
```

### The actor, and how much it is worth

Every record carries `actor.verifiedBy`, and reading it is the difference between a fact and a claim:

| `verifiedBy` | What it means |
|---|---|
| `peer-socket` | The kernel established it — `SO_PEERCRED` on the daemons' control sockets, or the per-caller `peers/` directory the SDK's RPC server uses where Node can't reach `SO_PEERCRED`. Unforgeable by the caller. |
| `token` | The actor presented a bearer credential the requester never sees. Proves possession of a secret bound to that name, and nothing more. |
| `self-asserted` | The actor named itself and nothing checked. |

Self-asserted actors are recorded rather than rejected: "we don't know who this was" is itself a finding. But never read one as an identity.

This is not identity in `REMEDIATION.md` 5.2's sense. There is no user directory, no tenancy, no RBAC, and revocation means editing a file.

### Decisions

`allowed`, `denied`, and `unavailable`. The third is its own outcome on purpose — a governor that timed out never rendered a verdict, and under `mode: "fail-open"` the call then *ran* with no policy check at all. That is the branch a reviewer most needs to be able to find, and it used to be a `console.warn`.

An agent step that threw is recorded as `allowed` with a `reason`, not as `denied`. Nothing refused it; it ran and broke.

## Turning it on

```ts
import { createFileAuditSink, defaultAuditPath } from "@berth/audit";
import { createAgent } from "@berth/agents";
import { homedir } from "node:os";

const audit = createFileAuditSink({ path: defaultAuditPath(homedir()) });

const { agent } = await createAgent({
  apps: ["filesystem"],
  audit,                                  // governance verdicts + agent steps
  actor: { kind: "operator", id: "alice", verifiedBy: "token" },
});
```

`audit` on `createAgent` wires the sink into both the step tracer and the Computer's governance gate — turning on half an audit trail is rarely what anyone means. For a `Computer` you built yourself, pass it directly: `Computer.boot({ governance: { audit, actor } })`.

`berth-grants` writes to the same default path with no configuration, and `BERTH_AUDIT_PATH` overrides it.

### Payload capture

Off by default, in two independent places:

- `createFileAuditSink({ capturePayloads: true })` — whether `input`/`output` reach the file.
- `createAgent({ tracePayloads: true })` — whether tool arguments and results are put on the step event at all.

Both default off because records land plaintext on disk (`REMEDIATION.md` 5.4 is open) and tool arguments are where customer data turns up. When on, values pass through `redact()`: secret-looking keys (`password`, `token`, `apiKey`, `authorization`, …) become `[redacted]`, oversized strings and buffers become a size marker rather than a prefix — half a credential is still a credential — and cycles, functions, and over-deep structures are described instead of dropped.

`redact()` is a deny-list, which fails open on the key nobody thought of. It is a second line of defence behind capture being opt-in, not the only one.

## Reading it back

```
berth audit list                          # everything, oldest first
berth audit list --decision denied        # just refusals
berth audit list --actor alice --limit 50
berth audit list --json                   # raw records
berth audit verify                        # check the hash chain
```

## The chain, and what it does not prove

Each record's `hash` covers `prevHash` plus its own canonical JSON, so a record cannot be edited, deleted, or reordered without breaking every hash after it. The chain survives a restart (the sink resumes from the last record's hash) and rotation (a new segment's first record carries the previous segment's last hash), and `berth audit verify` walks segments oldest-first across both.

**This is tamper-evident, not tamper-proof.** Anyone who can write the file can recompute every hash from the line they edited onwards and produce a chain that verifies cleanly. Getting past that needs the hashes somewhere the editor cannot reach — an append-only store, a remote sink, periodic external anchoring — none of which is built. `berth audit verify` says so in its own output rather than implying a guarantee it does not have.

## Operational notes

- **Writes are synchronous.** A record buffered when the process dies is a record that does not exist, and these are the events a crash would otherwise erase. Volume is low: a line per governance verdict and grant decision, not per HTTP request.
- **A failing sink never fails the audited action.** It reports on stderr and drops the record. Both the sink and every call site catch — a monitoring backend having a bad day must not become a failed tool call.
- **Rotation** defaults to 16MB and 5 files. There is no retention policy beyond that; pruning older segments is left to whatever already manages the host.
- **`agent-init`'s boot events** are separate — they go to container stderr, not to this sink, since they run inside the sandbox before any of this exists. They are parseable JSON with a `"source":"agent-init"` field (the old `[agent-init] ` prefix made them unparseable, also 5.1).

## What is still open

- **No remote sink.** Everything is local files. A trail an attacker with host write access can rewrite is worth less than one shipped off the box.
- **No encryption at rest** (5.4). Records are plaintext, which is why payload capture is opt-in.
- **No retention or legal-hold policy** beyond size-based rotation.
- **HTTP access logs are Fastify's**, not audit records — they go to stdout and are not chained.
- **Grant requests are unauthenticated.** `POST /grants` takes an app name from the request body over plain HTTP, so `grant.request` records are `self-asserted` by construction.
