# Verification record — containment benchmark (BUILD_PLAN M2.2)

Date: 2026-08-23. Runner: `node bench/run.mjs` on the Colima enforcing host
(`DOCKER_HOST=unix://~/.colima/default/docker.sock`, kernel 6.8.0-117-generic,
Ubuntu 24.04.4, arm64). Generated artifacts committed at
`bench/results/results.json` and `bench/results/table.md`.

## Result

| Harness | Contained | Escaped | Unmeasured | N/A | Score |
|---|---|---|---|---|---|
| Plain Docker (defaults) | 2 | 9 | 1 | 1 | 18% of 11 measured |
| Berth (as shipped) | 12 | 1 | 0 | 0 | 92% of 13 measured |
| Berth (weakened — positive control) | 8 | 4 | 1 | 0 | 67% of 12 measured |
| E2B | — | — | — | — | NOT RUN (no API key; human gate) |

Enforcement measured for the Berth run (the same measurement `berth attest`
records): doctor probe `enforcing`; agent-init reported `FullyEnforced` for
`bench-probe-a`, `bench-probe-b` and `context-bus-daemon`. The filesystem and
network rows therefore measured a real kernel boundary on this host.

## The positive control fired

`bench/run.mjs` exits non-zero if the weakened configuration does not contain
strictly fewer rows than the shipped one. Observed: **12 → 8**. The four rows
lost are exactly the ones Landlock was carrying — undeclared egress, both
co-tenant data rows, and (through the follow-on effect on name resolution) the
network reach detail. Weakening used only shipped knobs:
`BERTH_DISABLE_FS_SIDECAR=1` plus a seccomp profile that ENOSYSes the three
landlock syscalls.

## What the weakened column revealed, and why it is in the docs

Three rows stayed green **without** Landlock: `undeclared-write`,
`symlink-escape` and `foreign-secret-read`. That is not Landlock working — it
is DAC. The probe app runs as uid 10000, `/etc` is root-owned, and the
sibling's secret file is 0600 owned by another uid, so those writes and reads
fail on ordinary permissions before any LSM is consulted. The per-app uid work
(M1.1–M1.3) is carrying them.

This matters for how the Berth column should be read: a green cell means *the
action was refused*, not *Landlock refused it*. Each cell records the errno and
the failing syscall so the mechanism is recoverable from the results file, and
the weakened column is what makes the split visible.

Related detail from the same run: under the weakened config,
`host-network-reach` stayed contained because name resolution was refused
(`EPERM` on `getaddrinfo` — agent-init's seccomp filter denies UDP sockets to
an app that declared no network), while `undeclared-egress`, which dials a
literal IP and needs no DNS, escaped. Two different layers, one row apart.

## Berth's own red cell

`control-plane-exec` is 🔴 for Berth, plain Docker, and the weakened
configuration alike: a process injected through the container socket is not a
descendant of the restricted workload, so no in-sandbox policy binds it. This
row was added deliberately after the first full run scored Berth 100%, which
is not a result a self-authored benchmark should be comfortable publishing.
It restates in measured form what `docs/threat-model.md` already says in prose
about the `docker exec` bypass.

## Caveats, stated

- **Row selection is ours.** Every cell is a real measurement, but the choice
  of rows is the benchmark author's, and the author ships one of the columns.
  The rows come from the existing milestone suite and the threat model's
  adversary list; a reviewer who thinks a row is missing should open an issue
  — that is the intended failure mode, not silent absence.
- **E2B has never been run.** The adapter is written against the documented
  SDK surface and has never executed against the live service. Its column
  reads NOT RUN until someone with an account runs it, which is a human gate.
- **One host, one architecture.** arm64 Colima on macOS. Not yet run on the
  Docker Desktop daemon (where Berth's kernel rows would honestly degrade —
  the table prints the enforcement measurement in place of a green column) nor
  on x86 CI. The CI workflow covers the ubuntu-latest case on every push.
- **`imds-reach` is unmeasured on any laptop.** Nothing answers 169.254.169.254
  there. It is scored as unmeasured, never as a pass, and is only meaningful on
  a cloud host.
