# Attestation Record Specification

A standalone, versioned spec for the record a runtime emits to say what one run actually enforced, and what trusting that statement requires, plus a conformance suite that checks whether an implementation follows it.

- **[SPEC.md](./SPEC.md)**: the specification, version **1.0.0** ([VERSION](./VERSION)).
- **[conformance/cases.json](./conformance/cases.json)**: 115 machine-readable test cases across four levels.
- **[conformance/run.mjs](./conformance/run.mjs)**: the runner. No dependencies, no knowledge of any implementation.

The companion spec is [spec/capability-manifest](../capability-manifest): a manifest says what an app intends to touch, a record says what a boot did about it. They are versioned separately and share one thing, the enforcement-tier vocabulary (SPEC.md §5.4).

Only the reference adapter imports Berth. Where the spec and the implementation disagree, the spec is right and the implementation has a bug (SPEC.md Appendix B). For how Berth produces and checks these records, see the [attestation reference](../../docs/attestation-reference.md).

## The two rules that matter

Anyone can publish JSON that says `"enforcement": "active"`. Two rules make that claim checkable:

- **The verdict is derived, not asserted.** A record carries the measurements behind its verdict, and a conforming verifier recomputes the verdict from them (SPEC.md §5.2, §5.3). Changing `NOT_ENFORCED` to `ACTIVE` and recomputing the digest gives a record every conforming verifier still rejects.
- **Every record states its trust model.** `trustModel` is a required field saying what trusting the record requires: tamper-evident or tamper-proof, who produced the measurements, what it doesn't prove (SPEC.md §4.3). A verifier can't check that the text is true, only that it's there.

## Run the conformance suite

Against the reference implementations, from the repo root:

```sh
pnpm --filter @berthos/audit build
pnpm --filter @berthos/spec-attestation-record conformance          # standalone verifier
pnpm --filter @berthos/spec-attestation-record conformance:library  # @berthos/audit
```

There are two reference implementations: the standalone script `scripts/verify-attestation.mjs`, which depends only on `node:crypto`, and `verifyAttestation()` in `@berthos/audit`. Running the same cases through both keeps them in step.

Against your own implementation, write an adapter in any language that speaks the JSON-Lines protocol in SPEC.md §8.2 (four operations: `describe`, `verify`, `derive`, `digest`), then:

```sh
node conformance/run.mjs --adapter "./my-adapter" --json report.json
```

| Flag | Meaning |
|---|---|
| `--adapter "<command>"` | Command that starts your adapter. Required. |
| `--tags <list>` | Run only these levels, for example `core,derivation,canonical` (the three required ones). `extended` is optional. |
| `--cases <path>` | Use a different case file. |
| `--json <path>` | Write a machine-readable report. |

A skipped case is reported and never counted as a pass. Levels and what you may claim for each are in SPEC.md §8.4. Passing is necessary but not sufficient (SPEC.md §8.1): the case `valid-trust-model-vacuous-is-still-valid` requires verifiers to accept a record whose whole trust model is the word "trustworthy", because no suite can judge whether the text is true.

## The suite's own check

```sh
pnpm --filter @berthos/spec-attestation-record selftest
```

Runs the suite three times and requires all three results: both reference verifiers pass, and [`conformance/adapters/broken.mjs`](./conformance/adapters/broken.mjs), a plausible verifier with seven real defects (starting with reading the verdict instead of deriving it), **fails**. A suite that nothing can fail proves nothing.

## Versioning

`VERSION` moves independently of every `package.json` in this repo and of the capability manifest spec (SPEC.md §11):

- **Patch:** editorial.
- **Minor:** additive, such as new optional fields or problem codes. Older verifiers cope because unknown fields must be ignored.
- **Major:** anything that could make a previously valid record invalid, or change the derivation table or canonicalization.

This is separate from the `schemaVersion` field *inside* a record, which versions the record shape within one implementation.
