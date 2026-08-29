# Writeup skeleton — "An attestation that can say no"

Status: skeleton (BUILD_PLAN rule 4 — the maintainer publishes; every claim
below already has its artifact). Companion artifacts:
[attestation-reference.md](../../attestation-reference.md),
`attestation-milestone.mjs`, `scripts/verify-attestation.mjs`,
[verification record](../verification/attestation-2026-08-23.md).

## The one-sentence pitch

Every sandbox vendor tells you their isolation works; `berth attest` emits a
record whose verdict is *derived from measurements* the record carries with
it — so the same command, on a host where nothing enforces, says
`NOT_ENFORCED` to your face.

## The shape of the piece

1. **The problem with "trust me" security claims.** Benchmarks and docs
   describe the product's best host. Nobody's README says "on your machine,
   probably nothing is enforced." But that's the truth on every Docker
   Desktop Mac (link the boot banner and the kernel-enforcement matrix).

2. **What the record binds** — five facts, four sources, one JSON file:
   audit-chain head (and the run's slice of it), agent-init's ruleset report
   read back off the boot's own stderr, the doctor probe for that
   kernel+runtime, the sha256 of the policy file the kernel actually loaded,
   boot id + image digest. Show a real record from the verification runs —
   one `ACTIVE` from Colima, one `NOT_ENFORCED` from Docker Desktop, same
   day, same laptop. **The negative control is the feature.**

3. **The verdict nobody can hand-edit usefully.** `enforcement.status` is
   recomputable from the embedded measurements, and the standalone verifier
   recomputes it. Editing the verdict without the measurements: caught by the
   self-hash. Editing it *with* a recomputed self-hash: caught by the
   derivation check. Editing the measurements too: now you're forging kernel
   output, which is the trust-model paragraph. (Milestone checks 5 and 6.)

4. **The uncomfortable paragraph, kept in-band.** Every record carries a
   `trustModel` field saying it is tamper-evident, not tamper-proof: the
   emitting host could rewrite everything before the chain head leaves its
   reach, and nothing is key-signed yet. The honesty constraint is schema —
   the verifier *rejects* a record without it. This is the section that
   makes the piece credible; do not soften it.

5. **What's next, claimed only as next**: signing, a counter-signed public
   chain head (the break-out box, M2.3, will publish its own boot
   attestation), and the containment benchmark emitting attestations per
   cell (M2.2).

## Demo material

- 30-second terminal capture: `berth attest run-x` on Colima → `ACTIVE`;
  same command against Docker Desktop → `NOT_ENFORCED` warning on stderr;
  `node verify-attestation.mjs` accepting both; `sed`-edit one field →
  reject.
- Pre-publish checklist: re-run the milestone on the demo host that morning;
  every command in the capture verbatim from attestation-reference.md.
