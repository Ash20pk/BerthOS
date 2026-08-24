# Verification record — Attestation Record Specification 1.0.0 + conformance suite

BUILD_PLAN **M3.2**. Branch `m3/manifest-spec`. Run 2026-08-24.

**Environment:** macOS 25.6.0 (darwin), Node v22.14.0, pnpm 10.21.0. No Docker
and no kernel features are involved — this milestone tests the *record contract*
(shape, digest, derivation, verifier algorithm), not whether the measurements a
record carries were honestly obtained. That is asserted on a real host, with a
negative control, by `attestation-milestone.mjs` (M2.1, recorded in
[attestation-2026-08-23.md](./attestation-2026-08-23.md)).

## What was run

```
$ node spec/attestation-record/conformance/run.mjs \
    --adapter "node spec/attestation-record/conformance/adapters/berth.mjs --impl standalone"

Attestation Record conformance 1.0.0
implementation: Berth reference implementation — scripts/verify-attestation.mjs
                (standalone, node:crypto only)
                (targets spec 1.0.0, record schemaVersion 1, kind "berth.attestation")
115 of 115 cases selected

115 passed, 0 failed, 0 skipped (a skip is not a pass)
```

```
$ node spec/attestation-record/conformance/selftest.mjs ; echo $?
115 passed, 0 failed, 0 skipped (a skip is not a pass)
OK   standalone verifier passes the suite
115 passed, 0 failed, 0 skipped (a skip is not a pass)
OK   library verifier passes the suite
OK   broken adapter fails the suite on 75 case(s) — the suite is falsifiable
0
```

115 cases: 84 `verify`, 16 `derive`, 14 `digest`, 1 `describe`. By level: 75
`core`, 18 `derivation`, 14 `canonical`, 10 `extended` (two cases carry both
`core` and `derivation`).

The `verify` cases are built from three sealed base records — an `ACTIVE` one,
a `NOT_ENFORCED` one, and an `UNDETERMINED` one — mutated by a patch and then
re-sealed **using the digest the adapter under test returns**. That is the one
design decision in the runner worth naming: it means the runner implements no
part of the specification itself, a shape case can never fail for a
canonicalization reason, and a canonicalization bug shows up only in the
`digest` cases, where a reader can act on it.

## Two reference implementations, one corpus

M2.1 shipped the verifier twice on purpose — `scripts/verify-attestation.mjs`
(nothing but `node:crypto`, the one a stranger runs) and `verifyAttestation` in
`@berth/audit` (the one `berth attest` checks its own output with). Two
implementations of the same algorithm drift; both stay internally consistent
while diverging from each other, and nothing notices.

The suite now runs the same 115 cases through each (`--impl standalone` /
`--impl library`), and CI runs both. Making them conform to one written document
is what turns "keep these in sync" from a comment at the top of a file into a
job that fails.

## What changed in the implementations to make this checkable

The spec needed an error contract a suite could assert on, so both verifiers now
report `{code, message}` problems drawn from the closed 17-code vocabulary of
SPEC §7 rather than bare prose. Writing the document also turned up three real
gaps in the implementations, now fixed in both and covered by cases:

| Gap | Why it mattered | Cases |
|---|---|---|
| `boot.imageDigest` was never checked | A record could omit the image identity entirely and read as complete; `"unknown"` is a fact, an absent field is an oversight | `invalid-image-digest-absent`, `invalid-image-digest-empty`, `valid-image-digest-unknown` |
| `generatedAt` was never checked | A record that cannot say when it was measured is not evidence of anything | `invalid-generated-at-*` (4), `valid-generated-at-offset` |
| `rulesetReports[].bootId` was never compared to `boot.bootId` | **The real one.** A record could attest a non-enforcing boot while carrying an enforcing boot's measurements and verify perfectly. The emitter always filtered by boot ID; nothing made the *verifier* insist on it, so a record from any other emitter — or a hand-assembled one — got away with it | `invalid-report-cites-another-boot`, `invalid-all-reports-cite-another-boot` |

The third is the one that justifies the milestone on its own. Writing the
verifier algorithm down as something a stranger must be able to reimplement is
what surfaced it; it was invisible for as long as the emitter and the verifier
were read as one system.

Also fixed: `verifyAttestation` threw on a non-mapping input (destructuring
`null`), which SPEC §2.3 forbids — verification must be total. Covered by the
seven `totality-*` cases, including a 200-deep nesting.

## The control — the suite can fail something

`conformance/adapters/broken.mjs` is a plausible verifier carrying seven
deliberate defects. It fails **75 of 115**. Grouped by what the runner actually
printed:

| Defect | How it surfaced | Cases |
|---|---|---|
| 1. reads `enforcement.status` instead of deriving it (SPEC §5.3) | *accepted a record the spec requires it to reject* | `tamper-verdict-upgraded-and-resealed`, `tamper-verdict-upgraded-from-undetermined`, `tamper-verdict-downgraded`, `tamper-probe-erased-to-keep-active`, `tamper-failing-report-deleted-but-probe-still-says-so`, `tamper-reasons-cleared-verdict-kept` |
| 2. empty measurement set derives `ACTIVE`, not `UNDETERMINED` | *derived ACTIVE, expected UNDETERMINED (probe enforcing, 0 report(s))* | `derive-enforcing-no-reports`, `derive-unknown-no-reports`, `derive-unknown-all-full` |
| 3. never compares `rulesetReports[].bootId` to `boot.bootId` | *accepted a record the spec requires it to reject* | `invalid-report-cites-another-boot`, `invalid-all-reports-cite-another-boot` |
| 4. digests with `JSON.stringify` in insertion order | *digest "a1d46c3c…", expected "…"* | `digest-key-order-declared`, `digest-nested-mappings-and-sequences`, `digest-booleans`, `digest-numbers`, `digest-full-active-record`, `digest-full-not-enforced-record` |
| 5. treats `trustModel` as optional decoration | *accepted a record the spec requires it to reject* | `invalid-trust-model-absent`, `invalid-trust-model-empty`, `invalid-trust-model-not-a-string` |
| 6. reports problems as bare strings with no code | *rejected with problems carrying no machine-readable code* | 39 `invalid-*` / `tamper-*` cases |
| 7. throws on a `policies` mapping — verification is not total | *expected a boolean 'valid', got undefined* | `invalid-policies-not-a-list` |

Defect 4 is worth a second look: the broken adapter's digest is *self*-consistent
— the runner seals every shape case with the digest that adapter returns, so its
integrity checks all pass against itself. It fails only where the corpus pins an
expected hex, which is the point of having a `digest` op at all. An
implementation can be perfectly consistent with itself and interoperate with
nobody, and only a fixed expectation catches that.

## The uncatchable case, written into the corpus

`valid-trust-model-vacuous-is-still-valid` replaces the trust model with the
single word `"trustworthy"` and requires a conforming verifier to **accept** it.

That is not a gap in the corpus, it is the boundary of what conformance can
mean, made visible instead of left in a caveat. SPEC §4.3 requires a record to
carry a trust model and states a three-point minimum for its content; no suite
run from outside an implementation can check whether the prose is true, honest,
or even relevant. Same shape as M3.1's uncatchable defect (a proxy reported as
kernel tier), and the same conclusion: passing is necessary, not sufficient
(SPEC §8.1).

The mechanical half still bites. Making the field REQUIRED means an emitter
cannot ship without deciding what to write there, and a reader holding nothing
but the JSON always has *something* to read. That forcing function is the whole
of what a format can contribute; the rest is the emitter's honesty, which is
what M2.1's negative control on a real host is for.

## Residuals, named

- **No third-party implementation exists.** Both reference implementations are
  ours. Running one corpus through two of our own verifiers proves they agree
  with each other and with the document; it does not prove the document is
  implementable by someone who has not read our code. Axis 5 stays 0.
- **Canonicalization diverges from RFC 8785 (JCS)** for keys containing
  characters above U+FFFF: JCS sorts by code point, we sort by UTF-16 code unit,
  because the reference implementation predates the spec and rehashing every
  emitted record to gain nothing measurable was the worse trade. No field this
  spec defines has such a key, so the two agree on every conforming record.
  Documented in SPEC §3.1 as a wart, flagged in §11 as a 2.0.0 candidate, and
  **not covered by a conformance case** — writing one would pin the divergence
  in the corpus, which is the opposite of the intent.
- **The suite says nothing about emitters.** SPEC §9's four emitter MUSTs (never
  attest over a failing chain, never attest a run with no evidence, filter by
  boot, self-verify before returning) are unreachable through an adapter
  protocol that only ever hands a verifier a record. Berth's are asserted by
  `attestation-milestone.mjs`; anyone else's are asserted by nothing here.
- **`ruleset` is an open string.** The derivation rule needs only "exactly
  `FullyEnforced` or not", so an implementation reporting a different vocabulary
  conforms while meaning something we cannot inspect. Deliberate — the
  alternative was an enum that either loses information or invents it — but it
  means `NOT_ENFORCED` is the only verdict a foreign vocabulary can reach.
- **The corpus is ours.** Case selection is a judgement call, same caveat as the
  benchmark's row selection and M3.1's corpus. `broken.mjs` bounds how vacuous
  that can get; it does not eliminate it.
