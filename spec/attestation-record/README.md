# Attestation Record Specification

A standalone, independently versioned specification for the document a runtime
emits to say what one run actually enforced — and, in the same document, what
trusting that statement requires — plus the conformance suite that decides
whether an implementation actually implements it.

- **[SPEC.md](./SPEC.md)** — the specification. Version **1.0.0**
  ([VERSION](./VERSION)).
- **[conformance/cases.json](./conformance/cases.json)** — the machine-readable
  corpus, 115 cases across four levels.
- **[conformance/run.mjs](./conformance/run.mjs)** — the runner. No
  dependencies, no knowledge of any implementation.

It lives in this repository because Berth wrote it, not because Berth owns it.
Nothing here imports Berth except the reference adapter, and where the
specification and the implementation disagree, the specification is right and
the implementation has a bug (SPEC.md Appendix B).

It is the companion to [spec/capability-manifest](../capability-manifest): a
manifest says what an application intends to touch, a record says what a boot
did about it. The two are separately versioned and share exactly one thing —
the enforcement-tier vocabulary (SPEC.md §5.4).

## Why this needs a spec, and what the hard part is

Anyone can publish a JSON blob that says `"enforcement": "active"`. The
interesting question is what stops it from saying that when it isn't true.

Two rules do most of the work:

**The verdict must be derived, not asserted.** A record carries the
measurements the verdict was computed from, and a conforming verifier
recomputes the verdict from them (§5.2, §5.3). Editing `NOT_ENFORCED` to
`ACTIVE` and recomputing the self-hash produces a record with a perfectly valid
digest that every conforming verifier still rejects, because the measurements
no longer support the word. That turns "someone edited the verdict" from an
unfalsifiable suspicion into an offline check.

**Every record must state its own trust model.** `trustModel` is a REQUIRED
prose field saying what trusting *this record* requires — tamper-evident vs
tamper-proof, who produced the measurements, what the record does not prove
(§4.3). A record without it does not conform. A verifier cannot check that the
paragraph is honest, and the specification does not pretend it can; what it can
do is make an emitter write one down, next to the hash, where a reader who has
nothing else will see it.

Berth's own record says, in-band, that it is tamper-evident only until its
digest leaves the writer's reach. That is the sentence the format exists to
carry.

## Running the conformance suite

Against the reference implementations, from the repo root:

```sh
pnpm --filter @berthos/audit build
pnpm --filter @berthos/spec-attestation-record conformance          # standalone verifier
pnpm --filter @berthos/spec-attestation-record conformance:library  # @berthos/audit
```

There are deliberately two reference implementations — a standalone script
depending on nothing but `node:crypto`, and the library the emitter checks its
own output with — and running the same corpus through both is how they are kept
from drifting.

Against your own implementation — write an adapter speaking the JSON-Lines
protocol in SPEC.md §8.2 (four operations: `describe`, `verify`, `derive`,
`digest`), in any language, then:

```sh
node conformance/run.mjs --adapter "./my-adapter" --json report.json
```

`--tags core,derivation,canonical` runs only the required levels. A skipped
case is reported and never counted as a pass.

## The suite's own control

```sh
pnpm --filter @berthos/spec-attestation-record selftest
```

Runs the suite three times and requires all three: both reference verifiers
pass, and [`conformance/adapters/broken.mjs`](./conformance/adapters/broken.mjs)
— a plausible verifier carrying seven real defects, starting with reading the
verdict instead of deriving it — **fails**. A conformance suite nothing can fail
proves nothing about what passes it, so the falsification is part of the
deliverable rather than an afterthought. CI runs this on every push
(`.github/workflows/spec-conformance.yml`).

One case in the corpus exists to mark the boundary rather than to test an
implementation: `valid-trust-model-vacuous-is-still-valid` passes a record whose
entire trust model is the word "trustworthy", and requires a conforming verifier
to **accept** it. No suite run from outside an implementation can tell whether
its prose is true — which is why SPEC §8.1 says passing is necessary and not
sufficient.

## Versioning

`VERSION` moves independently of every `package.json` in this repo, and
independently of the capability manifest spec (SPEC.md §11). Patch: editorial.
Minor: additive — new optional fields or problem codes, which older verifiers
survive because unknown fields must be ignored. Major: anything that could
invalidate a previously valid record, change the derivation table, or change
canonicalization.

Don't confuse it with the `schemaVersion` field *inside* a record, which
versions the record shape within one implementation.
