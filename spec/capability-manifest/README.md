# Capability Manifest Specification

A standalone, independently versioned specification for the document an AI
agent uses to declare — ahead of running — every resource family it intends to
touch, plus the conformance suite that decides whether an implementation
actually implements it.

- **[SPEC.md](./SPEC.md)** — the specification. Version **1.0.0**
  ([VERSION](./VERSION)).
- **[conformance/cases.json](./conformance/cases.json)** — the machine-readable
  corpus, 87 cases across three levels.
- **[conformance/run.mjs](./conformance/run.mjs)** — the runner. No
  dependencies, no knowledge of any implementation.

Its companion is [spec/attestation-record](../attestation-record) — a manifest
says what an application intends to touch, an attestation record says what a
run actually enforced. The two are separately versioned and share exactly one
thing: the enforcement-tier vocabulary.

It lives in this repository because Berth wrote it, not because Berth owns it.
Nothing here imports Berth except the reference adapter, and where the
specification and `@berthos/manifest-schema` disagree, the specification is right
and the package has a bug (SPEC.md Appendix B).

## Why a spec, and why the tier vocabulary is in it

A manifest is portable; trust in a manifest is not. Two runtimes can accept the
same `filesystem:write:/workspace` line and mean wildly different things by it —
one refuses the syscall in the kernel, the other logs after the fact. So the
specification makes the honest answer mandatory: a conforming implementation
**must** publish a machine-readable tier table saying, per namespace and action,
whether enforcement is **kernel**, **broker**, **recorded**, or **unenforced**
(SPEC.md §5). An implementation that enforces perfectly and will not say so does
not conform.

That is the part worth exporting. The grammar is just a grammar.

## Running the conformance suite

Against the reference implementation, from the repo root:

```sh
pnpm --filter @berthos/manifest-schema build
pnpm --filter @berthos/spec-capability-manifest conformance
```

Against your own implementation — write an adapter speaking the JSON-Lines
protocol in SPEC.md §7.2 (four operations: `describe`, `validate`, `match`,
`tier`), in any language, then:

```sh
node conformance/run.mjs --adapter "./my-adapter" --json report.json
```

`--tags core,tiers` runs only the required levels. A skipped case is reported
and never counted as a pass.

## The suite's own control

```sh
pnpm --filter @berthos/spec-capability-manifest selftest
```

Runs the suite twice and requires *both*: the reference adapter passes, and
[`conformance/adapters/broken.mjs`](./conformance/adapters/broken.mjs) — a
plausible implementation carrying five real defects, including accepting
`filesystem:write:/` and reporting a proxy as kernel tier — **fails**. A
conformance suite nothing can fail proves nothing about what passes it, so the
falsification is part of the deliverable rather than an afterthought. CI runs
this on every push (`.github/workflows/spec-conformance.yml`).

## Versioning

`VERSION` moves independently of every `package.json` in this repo (SPEC.md
§10). Patch: editorial. Minor: additive — new namespaces or optional fields,
which older implementations survive because unknown fields must be ignored.
Major: anything that could invalidate a previously valid manifest.

Don't confuse it with the `schema_version` field *inside* a manifest, which
versions the manifest shape within one implementation.
