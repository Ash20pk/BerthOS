# Attestation reference

`berth attest <runId>` emits a per-run **attestation record**: one JSON
document binding together facts that otherwise live in four different places —
the audit trail, the sandbox's boot log, the enforced policy file, and the
Docker daemon's image records. Anyone holding the record can check it with a
standalone verifier that does not depend on Berth.

Honesty first, because this feature exists to make honesty checkable: the
record is **tamper-evident, not tamper-proof**, and it says so itself in a
mandatory `trustModel` field. See [What this does not prove](#what-this-does-not-prove).

## What a record binds

```
berth attest my-run-id --out my-run.attestation.json
```

| Field | Where it was measured |
|---|---|
| `auditChain.head` | `verifyAuditChain` walked every rotated segment of the audit file; this is the chain head at attestation time. The walk **fails the command** if the chain is broken — a record is never emitted over a chain that fails its own verification. |
| `run` | The count and seq/timestamp bounds of audit records whose `meta.runId` matches. Zero matching records is an error, not an empty attestation. |
| `enforcement.rulesetReports` | agent-init's `capability_policy_applied` events, read back from the container's own log stream and filtered to the current boot ID. `ruleset` is what the kernel returned from `landlock_restrict_self` — `FullyEnforced`, `PartiallyEnforced`, or `NotEnforced`. |
| `enforcement.doctorProbe` | The same behavioural probe `berth doctor` and the boot banner use, run fresh (never read from the operator-writable enforcement cache — see [what this does not prove](#what-this-does-not-prove)), for the same runtime this boot ran under (under gVisor the kernel being measured is the sentry — see [kernel-enforcement.md](./kernel-enforcement.md#optional-hardened-runtime)). |
| `enforcement.status` | **Derived, never asserted**: `ACTIVE` only when the probe says `enforcing` *and* every app's ruleset report says `FullyEnforced`. Any measured non-enforcement → `NOT_ENFORCED` with the reasons named. Missing measurements → `UNDETERMINED`, never quietly `ACTIVE`. |
| `policies[]` | sha256 of each app's `.berth/capability-policy.json`, computed **inside the container** over the exact bytes agent-init enforced from (which include grants-server-approved additions, not just what `berth.yml` declares). |
| `boot.bootId` | The entrypoint's per-boot UUID, from the container log. |
| `boot.imageDigest` | The image's content identity from the daemon (RepoDigest when it has one, image config ID otherwise). |
| `recordSha256` | sha256 over the canonical JSON of every other field, stamped at emission. |

The negative control is the feature: the same policy attested on a host whose
kernel does not enforce Landlock (Docker Desktop's linuxkit VM, or gVisor's
sentry today) produces `NOT_ENFORCED` — asserted end-to-end in
`attestation-milestone.mjs`, which also boots a control sandbox under a
seccomp profile that removes the landlock syscalls and watches the verdict
flip on an enforcing host.

## Verifying a record

```
node scripts/verify-attestation.mjs my-run.attestation.json
```

The verifier is a single file depending only on `node:crypto`. It checks:

1. **Shape** — required fields, sha256 formats, a positive run-record count.
2. **Integrity** — `recordSha256` matches the canonical JSON of the record.
   Any hand edit is rejected.
3. **Consistency** — the stated `enforcement.status` is re-derived from the
   embedded measurements. An editor who upgrades the verdict *and* recomputes
   the self-hash is still rejected, because the measurements no longer
   support the verdict. (Forging the measurements themselves is possible for
   whoever controls the emitting host — that is the trust model, below.)

The same checks exist as a library (`verifyAttestation` in `@berthos/audit`),
and `berth attest` runs them against its own output before writing anything —
a record the shipped verifier would reject is never emitted.

Each problem carries a machine-readable `code` from a closed vocabulary
(`digest-mismatch`, `enforcement-status-underived`, `boot-id-inconsistent`, …)
alongside its prose, so a caller in any language can act on the reason rather
than grepping the message.

The record format, the canonical digest, the derivation rule, the verifier
algorithm, and that error vocabulary are written down as a standalone,
independently versioned specification with its own conformance suite:
**[spec/attestation-record](../spec/attestation-record)**. Both verifiers here
are reference implementations of it, and CI runs the same 115-case corpus
through each — which is how they are kept from drifting apart while each stays
internally consistent.

## What this does not prove

- **It does not prove the host told the truth.** Every input — the audit
  file, the container logs, the policy bytes, the probe — was read by
  software running on the host being attested. An operator with root there
  could rewrite the audit chain wholesale, re-emit the record, and both would
  verify. The record becomes evidence *against* that operator only once its
  `recordSha256` / `auditChain.head` leave their reach (posted somewhere
  append-only they don't control). Until then it is tamper-evident, not
  tamper-proof — the `trustModel` field in every record says exactly this.
- **It does not prove what the run did**, only that a hash-chained trail of
  it exists and where that chain stood. Read the trail itself for the what
  ([audit-reference.md](./audit-reference.md)).
- **It does not prove enforcement at any moment other than measurement.**
  The ruleset report is from boot; the probe is per kernel+runtime. A kernel
  that changed under a running boot (it can't, but a restarted container can)
  is why reports are filtered by boot ID.

  `berth attest` runs that probe **fresh**, deliberately bypassing the
  `$BERTH_HOME/enforcement-cache.json` cache that `berth dev`'s boot banner
  reads. The cache is operator-writable, and `doctorProbe` is one of the two
  measurements [`deriveEnforcementStatus()`](#the-derivation-rule) requires
  before it will say `ACTIVE` — so reading it here would have meant one edit
  to one JSON file could forge half an `ACTIVE` verdict with no kernel
  probed. It is still a probe of the host *now* rather than of the attested
  boot; what it rules out is a cached claim standing in for a measurement.
  Fixed 2026-08-29; before that, attestation read the cache.
- **It is not a signature.** Nothing here involves keys. `recordSha256`
  detects edits; it does not identify an author. Signing (and a
  counter-signed public chain head) is future work, deliberately not claimed.

## Command reference

```
berth attest <runId> [--os <name>] [--container <name>] [--image <tag>]
                     [--file <audit.jsonl>] [--out <path>]
```

- `runId` must appear as `meta.runId` in the audit trail — that is what the
  agent tracer (`createAuditStepTracer`) writes on every step record.
- With no `--container`, the boot is found via the `berth os` state record
  (`--os`, defaulting to the only recorded instance).
- `--out` writes the record 0600; otherwise it prints to stdout. A verdict
  other than `ACTIVE` is also warned to stderr so it can't scroll past.

Verification artifact for BUILD_PLAN M2.1:
`packages/docker-orchestrator/test/attestation-milestone.mjs`, run by
`.github/workflows/attestation-milestone.yml`.
