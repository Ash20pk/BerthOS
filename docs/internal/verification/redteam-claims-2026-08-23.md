# Verification record — claims inventory + red-team suite (BUILD_PLAN M2.4)

Date: 2026-08-23. Branch `m2/claims-inventory`. Enforcing host: Colima
(`DOCKER_HOST=unix://~/.colima/default/docker.sock`, kernel 6.8.0-117-generic,
Ubuntu 24.04.4, arm64).

## Claims inventory

`docs/internal/claims.md` — 56 claim rows across kernel (K1–K21), broker
(B1–B15), host (H1–H5), recorded (R1–R6) and unenforced (U1–U9) tiers, plus a
"UNPROVEN and weakly-proven" work list. Every kernel/broker/host/recorded row
cites a proving test or carries an honest no-milestone marker.

`node redteam/claims-linter.mjs` → `56 claim rows, 2 UNPROVEN. OK — every cited
test resolves, every claim row carries evidence.`

**Linter is not vacuous** (mutation self-test): renaming K16's cited test to a
non-existent path made the linter exit 1 with
`K16: cites "…/DELETED-milestone.mjs", which does not exist on disk`; restoring
the file returned it to green.

## Red-team mutation suite

`node redteam/redteam.mjs` → all checks PASS. Measured enforcement for the
shipped box: probe `enforcing`, all apps `FullyEnforced`. Three kernel-tier
attack classes, each **denied** under the shipped box and **allowed** under the
mutated (kernel-tier-off) box:

- `undeclared-write` — read of the 0644 kernel-tier flag: EACCES shipped, flag
  captured when mutated.
- `symlink-escape` — same read through a planted symlink: EACCES shipped, flag
  captured when mutated.
- `undeclared-egress` — outbound TCP: `ERROR:EACCES` shipped, `CONNECTED` when
  mutated.

The mutation flipping each one is what proves the denial was caused by the
kernel tier, not by a file mode or an absent route — a denial that did not flip
would fail the suite as hard as one that did not hold. The scratch-write
control confirms the box runs attacks at all.

## Scope, stated honestly

- **Not every attack class has a clean mutation here.** The namespace and
  co-tenant-socket denials come from agent-init's own seccomp filter and the
  per-app uid split, which the weakened boot does not disable. Those are proven
  (with their own controls) by `capability-enforcement.mjs` and
  `per-app-secrets.mjs` — cited in claims.md — rather than re-mutated here. The
  red-team suite covers the classes it can mutate cleanly and says so, instead
  of pretending a full green grid.
- **The suite refuses to run on a non-enforcing host** (exits 1 under CI, skips
  locally) rather than report vacuous passes.
- **The linter checks that a citation resolves, not that the cited test asserts
  the claim.** That mapping is a human review at row-authoring time; the linter
  catches the failure mode that happens silently — a rename orphaning a claim.

## Audit pack (WS4.3)

`docs/internal/audit-pack.md` written: the reading order (threat model →
claims → attestation), the runnable-evidence table, the known-not-covered
list, the reporting path, and a maintainer-decision shortlist of external-eyes
venues. WS4.3's done-when is "pack exists; maintainer decision requested" — the
pack exists; the decision is the human gate.
