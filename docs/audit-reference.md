# Audit trail reference

`@berthos/audit` writes a hash-chained log of what happened and who did it: every tool call made through `berth mcp`, every governance verdict and, if you turn it on, every step an agent takes. Use it when you need to answer "what did this agent do, and was it allowed?" after the fact.

## Turn it on

### `berth mcp`: on by default

Every tool call through [`berth mcp`](./mcp-bridge-reference.md) is recorded under the session's run id, which the bridge prints on stderr when it starts:

```
[berth:mcp] recording tool calls in ~/.berth/audit/audit.jsonl as run mcp-filesystem-20260928T101500Z-3fa2c1 — attest it with `berth attest mcp-filesystem-20260928T101500Z-3fa2c1`
```

This covers any agent that reaches Berth over MCP, including Claude Code, Cursor, and a LangChain or other loop using an MCP adapter. Pick the run id yourself with `--run-id`, write somewhere else with `--audit-file`, or turn it off with `--no-audit`. The bridge also records the sandbox's boot evidence once per session, so the run can be [attested](./attestation-reference.md) after the sandbox has stopped.

### The agent framework

```ts
import { createFileAuditSink, defaultAuditPath } from "@berthos/audit";
import { createAgent } from "@berthos/agents";
import { homedir } from "node:os";

const audit = createFileAuditSink({ path: defaultAuditPath(homedir()) });

const { agent } = await createAgent({
  apps: ["filesystem"],
  audit,                                  // governance verdicts + agent steps
  actor: { kind: "operator", id: "alice", verifiedBy: "token" },
});
```

`audit` on `createAgent` feeds both the step tracer and the Computer's governance gate. For a `Computer` you boot yourself, pass it to the gate: `Computer.boot({ governance: { audit, actor } })`. `@berthos/agents` is the experimental agent framework and isn't published; use it from a clone.

The default path is `~/.berth/audit/audit.jsonl`. See [`examples/audit-trail`](../examples/audit-trail) for a runnable demo that edits a record and catches it.

## Read it back

```bash
berth audit list                          # everything, oldest first
berth audit list --decision denied        # just refusals
berth audit list --actor alice --limit 50
berth audit list --json                   # raw records, one per line
berth audit verify                        # check the hash chain
```

| Flag | Command | Meaning |
|---|---|---|
| `--file <path>` | `list`, `verify` | Audit file to read. Default `~/.berth/audit/audit.jsonl`. |
| `--decision <d>` | `list` | Only `allowed`, `denied` or `unavailable`. |
| `--actor <id>` | `list` | Only records whose `actor.id` matches. |
| `--action <prefix>` | `list` | Only records whose `action` starts with this. |
| `--limit <n>` | `list` | The most recent `n` matching records. |
| `--json` | `list` | Print raw records instead of the formatted view. |

`berth audit verify` checks every rotated segment, oldest first, and exits non-zero at the first `BROKEN` record.

## What a record looks like

One JSON object per line, in a file with mode 0600:

```json
{"ts":"2026-08-16T09:14:22.104Z","seq":41,"actor":{"kind":"operator","id":"alice","verifiedBy":"token"},"action":"governance.evaluate","target":"filesystem.write_file","decision":"denied","reason":"path outside /workspace/reports","durationMs":12,"meta":{"mode":"fail-closed"},"prevHash":"…","hash":"…"}
```

| Field | Meaning |
|---|---|
| `ts`, `seq` | ISO-8601 time and a sequence number, so records with the same timestamp still order. |
| `actor` | `{ kind, id, verifiedBy }`. `kind` is `operator`, `app`, `agent` or `anonymous`. |
| `action` | What happened: `tool.call` and `sandbox.boot` (from `berth mcp`), `governance.evaluate`, or `agent.<step kind>` such as `agent.tool-call`. |
| `target` | What it happened to: `app.export`, `container:<name>`, `tool:<name>` or `run:<runId>`. |
| `decision` | `allowed`, `denied` or `unavailable`. |
| `reason` | Why. Always set for `denied` and `unavailable`. |
| `input`, `output` | Only with payload capture on (below), always redacted. |
| `meta` | Extras, redacted. `berth mcp` records and agent steps carry `meta.runId`, which is what `berth attest` looks up. A `sandbox.boot` record carries the boot evidence in `meta.evidence`, and a tool call the app failed carries `meta.failed`. |
| `prevHash`, `hash` | The chain. |

### How much to trust `actor`

| `verifiedBy` | Meaning |
|---|---|
| `peer-socket` | The kernel established it, from the socket the caller connected on. The caller can't forge it. |
| `token` | The actor presented a secret bound to that name. Proves possession of the secret, nothing more. |
| `self-asserted` | The actor named itself and nothing checked. Recorded so you know it's unknown; don't read it as an identity. |

This is not an identity system: there's no user directory, tenancy or roles.

### Decisions

- `denied`: the governor refused the call.
- `unavailable`: the governor didn't answer (error or timeout). Under `mode: "fail-open"` the call then ran with no policy check, so this is the record to look for. See [governance](./governance-reference.md).
- An agent step that threw is `allowed` with a `reason`. Nothing refused it; it ran and failed.

## Payload capture

Off by default, controlled in two places:

- `createFileAuditSink({ capturePayloads: true })`: whether `input` and `output` reach the file.
- `createAgent({ tracePayloads: true })`: whether tool arguments and results are put on step events at all.

When on, values pass through `redact()`. Keys that look secret (`password`, `token`, `apiKey`, `authorization`, `cookie`, …) become `[redacted]`, long strings become a size marker, and cycles and very deep structures are described instead of stored. `redact()` works from a list of key names, so a secret under an unexpected key gets through. Keep capture off unless you need it.

## How the chain works

Each record's `hash` is sha256 over `prevHash` plus the record's canonical JSON. Editing, deleting or reordering a record breaks every hash after it, and `berth audit verify` reports where. The chain continues across restarts and across rotation. Several processes can write the same file at once (two `berth mcp` sessions share the default path): each write takes a lock on `<file>.lock` and reads the chain's head from the file before appending, so they extend one chain rather than forking it. A lock left by a writer that died is broken once its pid is gone, or after 10 s.

[`berth attest`](./attestation-reference.md) builds on this chain to produce a checkable record of one run.

## Sink options

`createFileAuditSink(options)`:

| Option | Default | Meaning |
|---|---|---|
| `path` | required | JSONL file. Parent directories are created. |
| `capturePayloads` | `false` | Write redacted `input` and `output`. |
| `redact` | | Options passed to `redact()`. |
| `maxBytes` | 16MB | Rotate when the file reaches this size. |
| `maxFiles` | 5 | Rotated files to keep (`audit.jsonl.1` … `.5`). Older ones are deleted. |

Other sinks: `createMemoryAuditSink()`, `createConsoleAuditSink()` (stderr) and `combineAuditSinks(...)`.

## Operational notes

- **Writes are synchronous,** so a crash doesn't lose buffered records. Volume is low: one line per verdict or step.
- **A failing sink never fails the audited call.** It prints a warning on stderr and drops the record.
- **Rotation is size-based only.** There's no other retention policy; prune old segments with whatever manages the host.
- **After rotation deletes the oldest segment,** the chain no longer starts at the beginning. `berth audit verify` and `berth attest` check everything still on disk and print a note that earlier segments are gone. From the files alone, routine pruning and someone deleting segments look the same.
- **`agent-init` boot events** go to the container's stderr, not to this sink, as JSON lines with `"source":"agent-init"`.
- **HTTP access logs** are Fastify's, on stdout, and aren't chained.

## Limits

- **Tamper-evident, not tamper-proof.** Anyone who can write the file can recompute every hash from the line they edited and produce a chain that verifies. `berth audit verify` says this in its output.
- **Local files only.** There's no remote sink, so the trail is only as safe as the host.
- **Plaintext on disk.** Nothing is encrypted at rest, which is why payload capture is off by default.
