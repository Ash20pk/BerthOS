# The containment benchmark

One attack probe, run in several sandboxes, producing a scorecard. It answers one question: **an attacker already has code execution inside the sandbox; what can they still touch?** Each row is one thing the probe tries. Each cell is what happened when it tried, on a real sandbox on your machine.

## Run it

```bash
pnpm install && pnpm build
node bench/run.mjs --harness docker,berth,berth-weakened
```

This writes:

- `bench/results/results.json`: every cell, with the errno and syscall that decided it.
- `bench/results/table.md`: the scorecard, generated from the JSON. Don't hand-edit it.

| Flag | Meaning |
|---|---|
| `--harness <ids>` | Comma-separated harnesses to run. Default: all of them. |
| `--out <path>` | Where to write the JSON. Default `bench/results/results.json`. |
| `--md <path>` | Where to write the scorecard. Default `bench/results/table.md`. |
| `--force` | Overwrite the results even if this run has fewer columns than the saved ones. |

Without `--force`, a run with fewer columns than the saved results refuses to overwrite them and prints the command that includes every column. Use `--out` and `--md` to write a partial run somewhere else.

The berth rows only measure the kernel when the host enforces Landlock (Linux 6.7+; Docker Desktop doesn't). On a Mac, set up an enforcing VM first with `berth doctor --fix` ([Mac setup](../docs/mac-enforcement.md)).

## Harnesses

| id | What it is |
|---|---|
| `docker` | `docker run` with defaults: workload as root, secrets passed with `-e`, whole filesystem writable. Not hardened, and not weakened either. |
| `berth` | Berth as shipped: capabilities from `berth.yml` compiled into Landlock and seccomp rules, one uid per app, secrets in a 0600 file. Two apps share the sandbox so the co-tenant rows have a real neighbour. |
| `berth-weakened` | Berth with its kernel layer switched off (`BERTH_DISABLE_FS_SIDECAR=1` plus a seccomp profile that makes the three Landlock syscalls fail). The control. |
| `e2b` | E2B's hosted sandbox. Needs `npm i @e2b/code-interpreter` and `E2B_API_KEY`; without the key the column reads NOT RUN. |

Every harness runs the same file, [`probe/probe.mjs`](./probe/probe.mjs), wherever that sandbox runs user code. No column gets its own version of a test.

## Read the scorecard

**Score** is `contained / (contained + escaped)`. Cells that aren't a pass or a fail are counted separately and left out of the score:

| Cell | Meaning |
|---|---|
| contained | The attempt was refused. |
| escaped | The attempt succeeded. |
| unmeasured | The row couldn't be established, for example no route to the internet to tell a block from a dead network. |
| n/a | The harness has nothing to attack for this row, such as co-tenant rows on a one-workload sandbox. |
| NOT RUN | The harness was skipped or failed. |

Each cell names the errno and the syscall, because which layer refused matters:

```
contained  connect to 1.1.1.1:80 refused with EACCES on connect
contained  resolving host.docker.internal refused with EPERM on getaddrinfo
```

The first is the network policy refusing the connection. The second is name resolution refused: Berth's seccomp filter denies UDP sockets to an app that declared no network.

**The weakened column** shows which rows depend on the kernel layer. Rows that stay green there are held by per-app uids and file permissions instead. If the weakened run doesn't score lower than `berth`, the runner exits non-zero, because the benchmark wouldn't be measuring anything.

**Caveats under a row** come from [`checks.mjs`](./checks.mjs). Where a Berth pass rests on something other than the kernel layer, the table says so under that row.

**Was the kernel enforcing?** The runner records the same measurement [`berth attest`](../docs/attestation-reference.md) does (the doctor probe plus each app's reported Landlock status) and prints it under the table. On a host without Landlock, the table says so instead of showing a green column.

## Add a harness

Add a module in `harnesses/` implementing `{ id, title, description, unavailableReason?(), run(ctx) }`, where `run` returns `{ probeResults, observations, meta }`, and register it in `run.mjs`. `ctx` gives you `repoRoot`, `probeDir`, `hostEndpoint` (a listener on the host for the host-reach row), `secretValue` (the canary to plant) and `log`.

Run the probe unmodified, in the same place that sandbox runs user code. A probe run with more privilege than a real workload gets makes the column meaningless.
