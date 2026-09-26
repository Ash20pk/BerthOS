# Verification record — Capability Manifest Specification 1.0.0 + conformance suite

BUILD_PLAN **M3.1**. Branch `m3/manifest-spec`. Run 2026-08-24.

**Environment:** macOS 25.6.0 (darwin), Node v22.14.0, pnpm 10.21.0. No Docker
and no kernel features are involved — this milestone tests the *manifest
contract*, not enforcement. What actually stands behind a declared capability is
asserted by the milestone tests named in [claims.md](../claims.md).

## What was run

```
$ node spec/capability-manifest/conformance/run.mjs \
    --adapter "node spec/capability-manifest/conformance/adapters/berth.mjs"

Capability Manifest conformance 1.0.0
implementation: @berthos/manifest-schema (Berth reference implementation)
                (targets spec 1.0.0, manifest schema_version 1)
allowlist: /workspace /context /tmp /app
87 of 87 cases selected

87 passed, 0 failed, 0 skipped (a skip is not a pass)
```

```
$ node spec/capability-manifest/conformance/selftest.mjs ; echo $?
OK   reference adapter passes the suite
OK   broken adapter fails the suite on 47 case(s) — the suite is falsifiable
0
```

87 cases: 18 `match` (glob semantics, exact namespace/action, non-symmetry,
literal `?`/`[`/`.`, colon-bearing scopes), 58 `validate` — 14 documents that
must be accepted and 44 that must be rejected at a named path (required fields,
null vs absent, per-index error paths, the six filesystem-scope rules,
`schema_version` resolution in all four directions, exports/governance/expose/
resources) — 1 `describe`, and 10 `tier`. By level: 63 `core`, 11 `tiers`, 13
`extended`; 2 of the core cases are `allowlist-dependent` and are judged against
whatever allowlist the adapter declares.

## The control — the suite can fail something

`conformance/adapters/broken.mjs` is a plausible implementation carrying five
deliberate defects. Which case caught which, verbatim from the run:

| Defect | Case that caught it |
|---|---|
| 1. filesystem scope checked only for being absolute | `invalid-fs-root` — *accepted a manifest the spec requires it to reject* (also `invalid-fs-dotdot`, `invalid-fs-outside-allowlist`, `invalid-fs-interior-star`, …) |
| 2. glob compiled without escaping regex metacharacters | `match-scope-dot-is-literal` — *matches("browser:navigate:a.com", "browser:navigate:axcom") = true, expected false* |
| 3. `expose.preview` defaults to `true` | `valid-expose-partial` — *normalized expose.preview: expected false, got true* |
| 5. errors carry no `path` | 17 `invalid-*` cases — *no error reported at path […]* |

**Defect 4 — reporting a proxy-enforced `browser:navigate` as kernel tier — was
NOT caught, on purpose.** No suite run from outside an implementation can check
whether a tier claim is true; it can only check that the claim exists, uses one
of the four words, and agrees with the implementation's own `tier` answers. That
is exactly why SPEC §7.1 says passing is *necessary, not sufficient*, and why the
tier table has to be backed by denial tests with controls — which for Berth is
[claims.md](../claims.md), not this suite. The defect is left in the broken
adapter as the standing reminder.

## Berth's declared tier table, and where each row comes from

Published by the reference adapter's `describe` (SPEC §5.2). Every row is
defensible against `claims.md`:

| Capability | Tier | Backed by |
|---|---|---|
| `filesystem:write` / `filesystem:read` | kernel | K1–K4, K10 (Landlock domain applied before the app execs) |
| `network:connect` | kernel | K5–K6 (Landlock `AccessNet` deny-by-default + seccomp for UDP/raw) |
| `network:peer` | broker | mesh-coordinator decides membership; not a kernel refusal of an undeclared peer |
| `app:invoke` | kernel | K11–K12 (per-caller socket paths; `EACCES` from `connect(2)`) |
| `github:read` / `github:write` | broker | B6–B8 |
| `browser:navigate` | broker | B1–B5 — host authorization cannot be kernel tier; the kernel sees ports, not hostnames |
| `browser:screenshot` | recorded | R6 — nothing denies it |
| `terminal:attach` | broker | K20 is explicitly *weak* (pty gating tested for presence, not for refusal without the grant), so the table reports the weaker reading rather than the flattering one |

`terminal:attach` is the row worth watching: the spec's own rule is that an
implementation MUST NOT report a capability above its weakest link, and this is
the first place applying that rule cost Berth a "kernel". When the K20 gap in
claims.md gets its denial test, the row moves — not before.

## Residuals, named

- **No third-party implementation exists yet.** The done-when's real bar ("a
  third party could implement it from the document alone") is not something an
  agent can verify by writing both sides; what is verified here is that the
  document is self-contained enough for the reference implementation to be
  judged by it, and that a from-a-skim implementation fails. The metric on the
  axis board stays 0.
- **YAML acceptance is not in the suite.** The adapter protocol hands over an
  already-parsed mapping, because there is no portable way to hand a byte stream
  to an arbitrary adapter. Berth's own YAML path (`loadManifest`, line-numbered
  errors) is covered by `packages/manifest-schema/src/schema.test.ts`.
- **The corpus is ours.** Case selection is a judgement call, same caveat as the
  benchmark's row selection. `broken.mjs` bounds how vacuous that can get, but
  does not eliminate it.
- **`spec/capability-manifest` sits in this repo** and is in the pnpm workspace
  so the reference adapter can import the package. Nothing under `spec/` imports
  Berth except that adapter; the runner and corpus have no dependencies at all.
