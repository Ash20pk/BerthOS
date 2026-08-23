# Verification record — attestation MVP (BUILD_PLAN M2.1)

Date: 2026-08-23. Runner: `packages/docker-orchestrator/test/attestation-milestone.mjs`
(14 checks) against two real daemons on the same Mac, same branch (`m2/attestation`),
same fixture (`boundary-app-a`, `target: "dev"`), same audit trail written by
`createFileAuditSink`.

## Colima (the enforcing host — docs/mac-enforcement.md)

`DOCKER_HOST=unix:///Users/ash/.colima/default/docker.sock`

- Independent measurement: probe=`enforcing`, agent-init ruleset=`FullyEnforced`.
- **Measured boot attested `ACTIVE`** — check 3 asserted the record's verdict
  equals the independent measurement, and it did.
- Control boot (seccomp profile ENOSYSing `landlock_create_ruleset`,
  `landlock_add_rule`, `landlock_restrict_self`): agent-init itself reported
  `NotEnforced`, and the **attestation flipped to `NOT_ENFORCED`** with
  agent-init's report named in `reasons[]` — the negative control, produced on
  a host that *can* enforce, by taking Landlock away from one boot only.
- Tamper checks: hand-edited `boot.imageDigest` → standalone verifier exit 1
  (self-hash); verdict flipped to the opposite status *with a recomputed
  self-hash* → verifier exit 1 (derivation mismatch).
- All 14 checks PASS.

## Docker Desktop (the non-enforcing host — the BUILD_PLAN row's named control)

Default socket (`desktop-linux` context).

- Independent measurement: probe=`unsupported` ("Function not implemented"),
  agent-init ruleset=`NotEnforced` — linuxkit's kernel has no active landlock LSM.
- **The same policy attested `NOT_ENFORCED`**, with both measurements in
  `reasons[]`: the doctor probe and agent-init's per-app reports (including
  `context-bus-daemon`'s).
- The standalone verifier **accepts** the honest `NOT_ENFORCED` record — an
  attestation that can only ever read `ACTIVE` proves nothing.
- All 14 checks PASS (check 3's expectation resolves per host; here it
  expected and got `NOT_ENFORCED`).

## Caveats, stated

- The Docker Desktop run rode the M1.1 loud fallback (sidecar propagation
  unavailable → in-sandbox FUSE mount, `CAP_SYS_ADMIN` back, warned) — that
  posture difference is orthogonal to what attestation measures and did not
  change any check's outcome.
- Neither run exercises `boot.runtime` (no gVisor on either daemon); the
  field is unit-tested and the probe is per-runtime since M1.4.
- Nothing here is a signature. See attestation-reference.md § What this does
  not prove.
