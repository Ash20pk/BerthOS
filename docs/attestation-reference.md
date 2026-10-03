# Attestation reference

`berth attest <runId>` produces an attestation record: one JSON file that says which run it covers, where the audit chain stood, which policies were enforced, and whether the kernel was actually enforcing them for that boot. Anyone can check the record with a standalone script, without installing Berth.

## Make one

```bash
berth attest mcp-filesystem-20260928T101500Z-3fa2c1 --out session.attestation.json
```

The run ID is the `meta.runId` on the run's [audit records](./audit-reference.md). Two things write one:

- **`berth mcp`**, for every tool call in a session, on by default. The run id is printed on stderr when the session starts, or you set it with `--run-id`. The bridge also records the sandbox's boot evidence while the sandbox is running, so you can attest the session after it has ended and the sandbox is gone. This is how you attest a run by Claude Code, Cursor, or a LangChain loop using an MCP adapter.
- **The agent framework's tracer** (`@berthos/agents`, experimental), on every step, when you give it an audit sink.

Where the boot evidence comes from:

| You pass | Evidence |
|---|---|
| `--os` or `--container` | Read now from that running sandbox. |
| Neither, and the run recorded its boot (`berth mcp` does) | The evidence recorded with the run, from the boot the run actually happened in. |
| Neither, and it didn't | Read now from the one `berth os up` instance. |

Recorded evidence is bound to the session that recorded it. A run id reused with `--run-id` across sessions that ran in different boots can't be attested from its records, because an attestation names one boot: `berth attest` refuses it, as it does a run where some session's calls have no recorded boot. Sessions that attached to the same running sandbox share its boot and attest together.

```
berth attest <runId> [--os <name>] [--container <name>] [--vm <name>] [--image <tag>]
                     [--file <audit.jsonl>] [--out <path>]
```

| Flag | Meaning |
|---|---|
| `--os <name>` | Which `berth os up` instance the run happened in, read live. Not needed for a `berth mcp` session. Otherwise defaults to the only recorded one. |
| `--container <name>` | Read boot evidence from this container instead of looking it up with `--os`. Needs `--image`. |
| `--vm <name>` | Read boot evidence from this running microVM sandbox (see `berth vm status`). See [A microVM boot](#a-microvm-boot). |
| `--image <tag>` | Image tag for the enforcement probe. Defaults to the instance's recorded image. |
| `--file <path>` | Audit file. Default `~/.berth/audit/audit.jsonl`. |
| `--out <path>` | Write the record here (mode 0600). Without it, the record prints to stdout. |

The command refuses to emit a record when:

- the audit chain fails verification,
- no audit record has `meta.runId` equal to the run ID,
- the record it built would fail its own verifier.

If the status is anything other than `ACTIVE`, it also warns on stderr with the reasons.

## Check one

```bash
node scripts/verify-attestation.mjs my-run.attestation.json
```

The verifier is one file that depends only on `node:crypto`, so you can copy it anywhere. It prints `OK` with the status, boot ID, image digest and chain head, or `FAIL` with each problem, and exits 1. It checks:

1. **Shape**: required fields are present, digests are sha256, the run has at least one record.
2. **Integrity**: `recordSha256` matches the record's contents, so any edit is caught.
3. **Consistency**: `enforcement.status` is recomputed from the measurements in the record. Changing `NOT_ENFORCED` to `ACTIVE` and recomputing the hash still fails, because the measurements don't support it.

The same checks are available as `verifyAttestation()` in `@berthos/audit`. Each problem has a `code` (such as `digest-mismatch`, `enforcement-status-underived`, `boot-id-inconsistent`) so a program can act on it.

## What a record contains

| Field | What it is |
|---|---|
| `trustModel` | A sentence stating what trusting this record requires. Always present. |
| `run` | How many audit records carry this run ID, with their first and last `seq` and timestamp. |
| `auditChain` | The audit file path, segment count, total records, and `head`: the chain's latest hash when the record was made. |
| `boot.bootId` | The sandbox's per-boot ID, from the container log. |
| `boot.imageDigest` | The image's identity from Docker. |
| `boot.runtime` | The container runtime, if one was set (for example gVisor). |
| `boot.isolation` | Only for a [microVM boot](#a-microvm-boot): what was booted, by hash, and that the guest had no network device. |
| `enforcement.rulesetReports` | What the kernel reported when each app's Landlock policy was applied at this boot: `FullyEnforced`, `PartiallyEnforced` or `NotEnforced`. |
| `enforcement.doctorProbe` | A fresh run of the `berth doctor` probe for this image and runtime: `enforcing`, `present_not_enforcing`, `unsupported` or `unknown`. |
| `enforcement.status` | The verdict, computed from the two measurements above. |
| `policies[]` | sha256 of each app's enforced policy file, computed inside the container. |
| `recordSha256` | sha256 over the canonical JSON of every other field. |

The boot evidence `berth attest` gathers (and `berth mcp` records with a run) also has `resourceLimits`: whether this boot gave each app its own cgroup and, per app, the limits the kernel held after `entrypoint.sh` wrote them. It isn't a field of the record. The declared limits are already covered by `policies[]`, because each app's `cgroupLimits` is in the policy file that gets hashed. See [resource limits](./resource-limits.md).

### How the status is decided

| Status | When |
|---|---|
| `ACTIVE` | The probe says `enforcing` and every app reported `FullyEnforced`. |
| `NOT_ENFORCED` | The probe says `unsupported` or `present_not_enforcing`, or any app reported something other than `FullyEnforced`. `enforcement.reasons` names each one. |
| `UNDETERMINED` | A measurement is missing: the probe returned `unknown`, or no app reported for this boot. |

On a host without Landlock, such as Docker Desktop, the same policy attests `NOT_ENFORCED`. Under gVisor, the probe measures gVisor's kernel, not the host's; see [enforcement](./kernel-enforcement.md#optional-hardened-runtime-gvisor--berth_runtime).

## A microVM boot

A session run with `--runtime vm` (the [local microVM runtime](local-vm.md)) produces the same record from the VM's own sources:

| Field | In a VM boot |
|---|---|
| `boot.bootId` | berth-init's boot id, from its control port |
| `boot.imageDigest` | `sha256:<rootfs>`, the content-addressed base image the VM booted |
| `boot.imageTag` | `rootfs-<first 12 hex>.erofs` |
| `boot.runtime` | `berth-vmm` |
| `boot.isolation` | `{ kind: "microvm", engine: "libkrun", hypervisor, kernel: { sha256, pinned, linux, configSha256, cmdline }, rootfs: { sha256, pinned, fstype, readOnly }, state: { chunkedSha256, sizeBytes, created }, tsi, nics, vcpus, memMiB, hostSandbox: { kind, applied, reason } }`, from berth-vmm's measurement, `vm_config` and `host_sandbox` lines. `hostSandbox` says whether berth-vmm confined itself on the host (`seatbelt` on macOS); a berth-vmm too old to say leaves it out |
| `enforcement.rulesetReports` | agent-init's `capability_policy_applied` lines on the guest log port, for this boot. Only the first per app, and only from that app's own stream |
| `enforcement.doctorProbe` | `enforcing` when the measured kernel is berth-vmm's pinned one and the running kernel lists `landlock` among its LSMs (berth-init's `boot_start`); `unsupported` when it doesn't; `unknown` for an unpinned kernel. Its `reason` says this is derived from the kernel's identity, not a behavioural probe run at this boot |
| `policies` | empty: the policy is compiled inside the guest, and berth-init doesn't report its sha256 yet |

`boot.isolation` is an extension field (spec §2.2). It is covered by `recordSha256`, older verifiers pass it through, and it never changes the verdict. `berth attest --vm <name>` reads a running VM sandbox live, as `--container` does for Docker.

## The spec

The record format, digest, status rule, verifier steps and problem codes are a standalone, versioned spec with its own conformance suite: [spec/attestation-record](../spec/attestation-record). Both verifiers here are reference implementations of it.

## What this does not prove

- **Tamper-evident, not tamper-proof.** Every input was read by software on the host being attested. Someone with root there can rewrite the audit chain, re-emit the record, and both will verify. The record only becomes evidence against that person once its `recordSha256` or `auditChain.head` is stored somewhere they can't change. The `trustModel` field in every record says this.
- **Not signed.** No keys are involved. `recordSha256` detects edits; it doesn't identify who made the record.
- **Not what the run did.** It shows that a chained trail of the run exists and where the chain stood. Read the [audit trail](./audit-reference.md) for what happened.
- **Enforcement at measurement time only.** The ruleset reports are from boot. The probe checks the host when you run `berth attest`, or, for a `berth mcp` session, when the session started.
- **Doesn't show pruning.** If rotation has deleted the oldest audit segments, `berth attest` warns on stderr, but the record looks the same as one over a complete chain.
