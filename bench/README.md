# The containment benchmark

One probe, several sandboxes, a generated scorecard.

The question this answers is not "is this sandbox secure" — it is narrower and
checkable: **an attacker already has code execution inside the sandbox. What
can they still touch?** Every row is one thing they try; every cell is what
happened when they tried it, on a real sandbox, on your machine.

```bash
pnpm install
node bench/run.mjs --harness docker,berth,berth-weakened
# → bench/results/results.json  (machine-readable, every cell with its errno)
# → bench/results/table.md      (the scorecard, generated — never hand-edited)
```

**A partial run will not overwrite a fuller scorecard.** The natural command
the day an `E2B_API_KEY` arrives is `node bench/run.mjs --harness e2b` — which
would leave a one-column file where the committed three-column table was, still
looking authoritative. The runner refuses that and prints the command that
includes the columns it was about to drop. `--force` overrides, and
`--out`/`--md` write somewhere else.

## What makes this different from a vendor benchmark

**One probe, not one per target.** [`probe/probe.mjs`](./probe/probe.mjs) is
the only place an attack is written down. Plain Docker runs it as the
container's command; Berth runs it inside the app's own restricted process; a
hosted sandbox runs it through its exec API. Nothing is reimplemented per
column, so no column can be quietly given an easier version of the same test.

**Unmeasured is not a pass.** A sandbox with no route to the internet looks
exactly like a sandbox that forbids egress — unless you read the errno. Rows
that could not be established come back `unmeasured`, are excluded from the
denominator, and are printed in their own column. A harness is never rewarded
for a row that did not run.

**Not-applicable is not a pass either.** A harness that runs one workload per
sandbox has no co-tenancy surface. Those rows read `n/a` rather than green: not
having a door is not the same as locking it.

**The positive control is enforced, not asserted.** The runner boots Berth a
second time with its kernel tier deliberately switched off
(`BERTH_DISABLE_FS_SIDECAR=1` plus a seccomp profile that ENOSYSes the three
landlock syscalls) and **exits non-zero if that configuration does not score
worse**. A benchmark where sabotage changes nothing is measuring nothing.

**Berth's own red cells stay red.** Where Berth passes a row on a mechanism
that is not finished, [`checks.mjs`](./checks.mjs) carries the caveat and the
generated table prints it under the row — for example the co-tenant socket row,
which rests on directory permissions because `SO_PEERCRED`
verification is still open.

## Reading a result

Each cell records the errno and the syscall that produced it, because *which
layer* refused matters:

```
contained  connect to 1.1.1.1:80 refused with EACCES on connect
contained  resolving host.docker.internal refused with EPERM on getaddrinfo
```

The first is a network policy refusing the reach. The second is name
resolution being refused (Berth's seccomp filter denies UDP sockets to an app
that declared no network) — the workload is contained either way, but by a
different mechanism. The weakened-Berth column exists to make those
distinctions visible: rows that stay green there were being carried by
per-app uids and DAC, not by Landlock.

## Harnesses

| id | what it is |
|---|---|
| `docker` | `docker run` with defaults: workload as root, secrets via `-e`, whole filesystem writable. Deliberately not hardened, and equally deliberately not sabotaged — no capability added, no default protection removed. |
| `berth` | Berth as shipped: capabilities from `berth.yml` compiled into a Landlock domain and seccomp filter, per-app uids, secrets via a 0600 file. Two apps boot in one sandbox so the co-tenancy rows have a real neighbour. |
| `berth-weakened` | The positive control described above. |
| `e2b` | **Never yet run against the live service.** Needs an `E2B_API_KEY`, which is a human gate. Without one the column reads NOT RUN, which is the honest result rather than an empty column implying something. |

## Was the kernel tier even live?

Berth's filesystem and network rows only measure a kernel boundary on a host
whose kernel has Landlock in its active LSM stack. The runner records the same
measurement `berth attest` does — the doctor probe plus agent-init's own
ruleset report — into the results file and prints it under the table. On a
host where Landlock is inactive (Docker Desktop's linuxkit VM, gVisor's sentry
today) the table says so in place of a green column. See
[docs/mac-enforcement.md](../docs/mac-enforcement.md) for a Mac setup where
those rows are real, and
[docs/attestation-reference.md](../docs/attestation-reference.md) for what the
enforcement record does and does not prove.

## Adding a harness

Implement `{ id, title, description, unavailableReason?(), run(ctx) }` in
`harnesses/`, returning `{ probeResults, observations, meta }`. `ctx` gives you
`repoRoot`, `probeDir`, `hostEndpoint` (a listener the runner opened on the
host for the reach row), `secretValue` (the canary to plant), and `log`. Run
the probe unmodified, in whatever position that harness gives to user code —
if you run it somewhere more privileged than a real workload gets, the column
is worthless.
