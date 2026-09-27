# Capability Manifest Specification

A standalone, versioned spec for the manifest an application uses to declare, before it runs, everything it intends to touch, plus a conformance suite that checks whether an implementation follows it.

- **[SPEC.md](./SPEC.md)**: the specification, version **1.0.0** ([VERSION](./VERSION)).
- **[conformance/cases.json](./conformance/cases.json)**: 87 machine-readable test cases.
- **[conformance/run.mjs](./conformance/run.mjs)**: the runner. No dependencies, no knowledge of any implementation.

The companion spec is [spec/attestation-record](../attestation-record): a manifest says what an app intends to touch, an attestation record says what a run actually enforced. They are versioned separately and share one thing, the enforcement-tier vocabulary.

Only the reference adapter imports Berth. Where the spec and `@berthos/manifest-schema` disagree, the spec is right and the package has a bug (SPEC.md Appendix B).

## Why the tier table is part of the spec

Two runtimes can accept the same `filesystem:write:/workspace` line and mean different things: one refuses the syscall in the kernel, the other logs it afterwards. So a conforming implementation **must** publish a machine-readable table saying, for each namespace and action, whether enforcement is **kernel**, **broker**, **recorded** or **unenforced** (SPEC.md §5). An implementation that doesn't publish it doesn't conform, however well it enforces.

## Run the conformance suite

Against the reference implementation, from the repo root:

```sh
pnpm --filter @berthos/manifest-schema build
pnpm --filter @berthos/spec-capability-manifest conformance
```

Against your own implementation, write an adapter in any language that speaks the JSON-Lines protocol in SPEC.md §7.2 (four operations: `describe`, `validate`, `match`, `tier`), then:

```sh
node conformance/run.mjs --adapter "./my-adapter" --json report.json
```

| Flag | Meaning |
|---|---|
| `--adapter "<command>"` | Command that starts your adapter. Required. |
| `--tags <list>` | Run only these levels, for example `core,tiers` (the two required ones). `extended` is optional. |
| `--cases <path>` | Use a different case file. |
| `--json <path>` | Write a machine-readable report. |

A skipped case is reported and never counted as a pass. Levels and what you may claim for each are in SPEC.md §7.4.

## The suite's own check

```sh
pnpm --filter @berthos/spec-capability-manifest selftest
```

Runs the suite twice and requires both results: the reference adapter passes, and [`conformance/adapters/broken.mjs`](./conformance/adapters/broken.mjs), a plausible implementation with five real defects (such as accepting `filesystem:write:/` and reporting a proxy as kernel tier), **fails**. A suite that nothing can fail proves nothing.

## Versioning

`VERSION` moves independently of every `package.json` in this repo (SPEC.md §10):

- **Patch:** editorial.
- **Minor:** additive, such as new namespaces or optional fields. Older implementations cope because unknown fields must be ignored.
- **Major:** anything that could make a previously valid manifest invalid.

This is separate from the `schema_version` field *inside* a manifest, which versions the manifest shape within one implementation.
