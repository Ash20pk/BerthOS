# Berth security audit pack

A self-serve starting point for anyone auditing Berth's enforcement — an
external reviewer, a disclosure venue, or a future maintainer. BUILD_PLAN M2.4 /
LAUNCH_PLAN WS4.3. This page is a map, not the territory: everything it points
at is in the repo and runnable.

## Start here, in this order

1. **[threat-model.md](../threat-model.md)** — the adversaries, the trust
   boundaries, the tier table, and an explicit "not protected against" list.
   Written to be adversarial; if it and a feature doc disagree, it wins.
2. **[claims.md](./claims.md)** — every enforcement claim, tagged by tier, each
   with the test that proves the denial or marked `UNPROVEN`. This is where a
   claim with nothing behind it has nowhere to hide. Its "UNPROVEN and
   weakly-proven" section is the shortlist of where to push hardest.
3. **[../attestation-reference.md](../attestation-reference.md)** and its "what
   this does not prove" section — how to check, per run, whether enforcement
   was actually live, and the limits of that check.

## Run the evidence yourself

Everything below runs on a Linux host whose kernel has Landlock in its active
LSM stack (`ubuntu-latest` qualifies; see
[mac-enforcement.md](../mac-enforcement.md) for a Mac setup). On a
non-enforcing host the kernel-tier suites say so rather than reporting vacuous
passes.

| What | Command | What it proves |
|---|---|---|
| The full milestone suite | the `*-milestone.yml` workflows / `node packages/docker-orchestrator/test/<name>.mjs` | each attack class is refused, with a positive or negative control (see claims.md for which) |
| Red-team mutation suite | `node redteam/redteam.mjs` | each kernel-tier denial *flips to allowed* when its mechanism is removed — the denials are not vacuous |
| Claims linter | `node redteam/claims-linter.mjs` | every claim in claims.md cites a test that exists |
| Containment benchmark | `node bench/run.mjs` | Berth vs plain Docker vs a deliberately weakened Berth, generated scorecard, unmeasured rows never scored |
| Break-out box | `node breakout/test/breakout-milestone.mjs` | a stranger's code cannot reach two flags no capability grants; the weakened boot proves the flag leaks when enforcement is off |
| Attestation | `node packages/docker-orchestrator/test/attestation-milestone.mjs` | a per-run record whose verdict is derived from live measurements, and a verifier that rejects a forged one |
| Spec conformance | `node spec/capability-manifest/conformance/selftest.mjs` | the reference implementation matches the published [Capability Manifest Specification](../../spec/capability-manifest/SPEC.md), **and** a deliberately non-conforming adapter fails the same suite. It does *not* prove any tier claim is true — a tier is only as good as the denial test behind it in claims.md |

Each of these runs in CI on every push — see `.github/workflows/`.

## What we already know is not covered

Named so a reviewer does not have to discover them:

- The **UNPROVEN / weakly-proven** rows in [claims.md](./claims.md) — the
  governance gate on the TCP cross-container listener (milestone-untested),
  `terminal:attach` without the grant, the Chromium renderer sandbox, and a
  few minor events.
- The **unenforced** rows in claims.md and threat-model.md — `docker exec`, the
  mesh daemon's retained uid 0 + `CAP_NET_ADMIN`, per-syscall audit logging,
  and the enterprise-ops gaps (*5.x*). These are documented not-a-boundary, not
  oversights.

## Reporting

[SECURITY.md](../../SECURITY.md) has the private disclosure path. A bypass of
anything tagged **kernel** or **broker** in claims.md is a vulnerability. A gap
in something already tagged **unenforced** or listed UNPROVEN is expected — but
a *worse-than-documented* version of one is still worth reporting.

## For the maintainer: external-eyes shortlist

WS4.3 asks for a decision, not an action, from an agent. Candidate venues to
consider once the break-out box is hosted (M2.3) and this pack is public:

- A public disclosure/bug-bounty surface pointed at the hosted break-out box,
  scoped by its `rules.md`.
- Independent review by a container-security or LSM-focused practitioner — the
  Kernel-tier claims (K1–K21) are the highest-value target and the ones an
  outside expert can most credibly check.
- Submitting the containment benchmark's methodology (one probe, run
  unmodified across harnesses; unmeasured never scored) for critique before
  publishing comparative numbers.

Maintainer decision requested — this pack is the material to hand any of them.
