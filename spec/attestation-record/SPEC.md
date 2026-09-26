# The Attestation Record Specification

**Version 1.0.0** — status: **stable**. Versioned independently of any
implementation; see [§11 Versioning](#11-versioning-of-this-specification).

An **attestation record** is a document in which a *runtime* states what one
specific run of one specific workload actually enforced, and — in the same
document — what trusting that statement requires. It is the counterpart to the
[Capability Manifest](../capability-manifest/SPEC.md): a manifest says what an
application intends to touch, a record says what a boot did about it.

This document defines the record's shape, the canonical form its self-digest is
computed over, the derivation rule that turns raw measurements into a verdict,
the algorithm a verifier MUST run, the machine-readable error contract it
reports through, and a conformance suite that decides whether an implementation
conforms.

It is written so that an implementer who has never seen the reference
implementations can build a conforming verifier from this text plus
[`conformance/cases.json`](./conformance/cases.json).

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL are to be interpreted as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they
appear in all capitals.

---

## 1. Scope and non-goals

**In scope.** The record document: which fields a conforming emitter MUST
produce, what each one means and where it was measured, the canonicalization
and digest that make the record tamper-*evident*, the rule by which a verdict
MUST be derived from measurements rather than asserted, the checks a conforming
verifier MUST perform, and the error codes it MUST report them under.

**Explicitly not in scope.**

- *How* a runtime measures anything. This specification never requires
  Landlock, seccomp, a hypervisor, a TPM, or any other mechanism. What it
  requires is that whatever was measured is carried **in the record**, so that
  the verdict can be recomputed by a reader who has never seen the host.
- **Authenticity.** Nothing here is signed. A record identifies no author and
  proves no origin. §10 says what that costs, at length, because a reader who
  mistakes this document for a signing scheme has mistaken the whole feature.
- Transport, storage, retention, and revocation of records.
- The audit trail's own format. A record *cites* a hash-chained trail by head
  digest; how that trail is built is the emitter's business.

### 1.1 What a conforming record is evidence of

Precisely three things, and it is worth stating them before the field list
rather than after:

1. That a document with these measurements existed in this exact form at the
   moment its digest was computed (**integrity**).
2. That the verdict it publishes is the one its own measurements imply
   (**consistency**).
3. That the emitter said, in-band, what the first two are worth
   (**disclosure** — §4.3).

It is evidence of nothing else. In particular it is not evidence that the
measurements are true; see §10.

---

## 2. Document model

### 2.1 Serialization

A record is a mapping. Its canonical serialization is JSON
([RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)), UTF-8, conventionally a
file named `<runId>.attestation.json`. Every conforming implementation MUST
accept JSON. An implementation MAY additionally accept an equivalent in-memory
mapping or another serialization of the same data model; acceptance MUST NOT
depend on the serialization chosen.

The data model uses only: mappings with string keys, sequences, strings,
integers, finite non-integer numbers, booleans, and — where a field's
definition explicitly permits it — absence. `null` is not part of the model:
an explicit `null` for any field defined below MUST be treated as that field
being malformed, not as it being absent.

### 2.2 Unknown fields

A verifier MUST accept a record containing fields this specification does not
define, and MUST NOT reject a record on their account. Unknown fields travel
through older verifiers unchanged, which is what makes §11's minor versions
additive.

A verifier MUST NOT let an unknown field change a verdict. Specifically: an
unknown field MUST NOT upgrade `enforcement.status`, satisfy a check that a
defined field failed, or suppress a problem code.

Unknown fields are **inside the digest** (§3.2). A record that carries an
extension field and a record that does not are different records with
different digests, even to a verifier that ignores the field.

### 2.3 Verification outcome

Verification of a record yields exactly one of:

- **valid** — no problems; or
- **invalid** — with at least one *problem*, each carrying a `code` from the
  closed vocabulary in §7 and a human-readable `message`.

Verification MUST be **total**: every input either verifies or produces
problems. A verifier MUST NOT crash, hang, or throw on any input, including a
non-mapping, a record missing every field, deeply nested values, and values of
unexpected types in every position.

Verification MUST be **exhaustive**: a verifier MUST report *every* check that
failed, not stop at the first. A reader repairing a record should need one
pass, and a suite asserting on codes needs the whole set. Problem order is not
significant, and a verifier MAY report codes beyond those a given input
strictly requires.

Verification MUST be **pure**: it depends only on the record. A conforming
verifier MUST NOT require the network, the emitting host, the audit file, the
container, or the clock. (Whether a *reader* should go check the cited chain
against an independent copy is a different question, and the answer is yes —
§10.)

---

## 3. Canonical form and the record digest

### 3.1 Canonicalization

The canonical form of a value is the string produced by:

1. **Strings** — serialized as JSON strings per RFC 8259 §7, using the shortest
   escape for each character that requires escaping: `\"`, `\\`, `\b`, `\f`,
   `\n`, `\r`, `\t`, and `\u00XX` for any other character below U+0020. No
   other character is escaped. Unpaired surrogates are escaped as `\uXXXX`.
2. **Numbers** — serialized as ECMAScript
   [`Number::toString`](https://tc39.es/ecma262/#sec-numeric-types-number-tostring)
   produces them: the shortest decimal string that round-trips. Integers carry
   no decimal point and no exponent within the range where that form is
   shortest. `NaN` and the infinities MUST NOT appear in a record.
3. **Booleans** — `true` / `false`. 
4. **Sequences** — `[`, the canonical form of each element in order joined by
   `,`, `]`. No whitespace.
5. **Mappings** — every entry whose value is *absent* is dropped; the remaining
   entries are sorted **ascending by the UTF-16 code units of the key**; the
   result is `{`, then `"key":value` for each entry joined by `,`, then `}`.
   No whitespace.

The canonical form contains no whitespace anywhere outside string values, and
no trailing newline.

> **Known divergence from RFC 8785 (JCS).** JCS sorts keys by Unicode code
> point; step 5 sorts by UTF-16 code unit. The two orders differ only for keys
> containing characters above U+FFFF. No field defined by this specification
> has such a key, so the two agree on every conforming record, but an
> implementation carrying extension fields with astral-plane keys MUST pick
> this rule rather than JCS to interoperate. This is a deliberate,
> documented wart rather than a silent one: the reference implementation
> predates the spec, and changing the digest of every already-emitted record to
> gain nothing measurable was the worse trade. §11 marks it as a candidate for
> 2.0.0.

### 3.2 The digest

`recordSha256` is the lowercase hex SHA-256 of the UTF-8 bytes of the canonical
form of the record **with the `recordSha256` entry removed** — not blanked, not
zeroed: removed, so the digest is taken over a mapping that has no such key.

Every other field, defined or unknown, is inside the digest. There is no
partial or selective coverage: a record either hashes all of itself or is
not conforming.

An emitter MUST stamp `recordSha256` last. A verifier MUST recompute it and
report `digest-mismatch` if it differs (§6 step 3).

### 3.3 What the digest is and is not

It detects **edits**. It does not identify an **author**, and it does not
detect **re-emission**: anyone able to run the emitter can produce a fresh
record with different measurements and a perfectly valid digest. A digest is a
seal on a document, not a statement about who sealed it or whether they were
telling the truth (§10).

---

## 4. Fields

All fields below are REQUIRED unless marked otherwise. A field that is absent,
`null`, or of the wrong type is *malformed*, and a verifier MUST report the
problem code named in that field's subsection.

### 4.1 `schemaVersion` (integer)

The version of the *record shape*, not of this specification (§11 distinguishes
them). A verifier MUST reject a record whose `schemaVersion` it does not
implement, with `schema-version-unsupported`. Version 1.0.0 of this
specification defines `schemaVersion` **1**.

Rejecting an unknown version is deliberately different from ignoring an unknown
*field* (§2.2): a field a verifier does not know is one it can safely skip; a
record shape it does not know is one where its checks may not mean what it
thinks they mean.

### 4.2 `kind` (string)

A constant identifying the document type, so a record found loose on disk is
self-identifying. The reference implementation emits `"berth.attestation"`.
A verifier MUST report `kind-invalid` for any other value.

An implementation MAY define its own `kind` constant; it MUST document it, and
MUST NOT accept a `kind` it does not emit.

### 4.3 `trustModel` (string) — the honesty constraint

A non-empty prose statement of what trusting *this record* requires, carried
in-band so that a reader who only ever sees the JSON — no README, no
documentation site, no link — still sees the limits.

A verifier MUST report `trust-model-missing` when it is absent or empty. This
is the field most likely to be dismissed as decorative, so, plainly: **a record
without it does not conform**, and an implementation that makes it optional has
not implemented this specification.

The statement MUST cover, at minimum:

1. Whether the record is tamper-evident or tamper-proof, in those words or
   clearer ones.
2. Who produced the measurements, and therefore who could have forged them.
3. What the record does **not** prove.

It MUST NOT overstate. A `trustModel` that claims a property the implementation
does not have is the single most damaging thing an emitter can write, because
the field's whole purpose is to be the sentence a reader trusts when they have
no other information.

*Rationale for making prose mandatory in a machine-readable format:* a verifier
cannot check that a trust model is honest, and this specification does not
pretend it can. What it can check is that the emitter was made to write one
down. The forcing function is the point.

### 4.4 `generatedAt` (string)

An [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339) date-time naming when the
measurements were read. A verifier MUST report `generated-at-invalid` for a
value that is absent or not an RFC 3339 date-time.

A verifier MUST NOT compare it against the current time: a record is not less
valid for being old, and a verifier with a wrong clock must not be able to
invalidate correct records. Freshness is a policy question for the reader, and
this specification deliberately leaves it there.

### 4.5 `runId` (string)

Non-empty. Identifies the run being attested, and MUST be findable in the cited
audit trail — that linkage is what makes `run` (§4.6) checkable by anyone
holding both documents. Problem code: `run-id-missing`.

### 4.6 `run` (mapping)

The attested run's slice of the cited trail.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `records` | integer > 0 | yes | How many records in the trail belong to this run |
| `firstSeq` / `lastSeq` | integer | no | Sequence bounds of that slice |
| `firstTs` / `lastTs` | string | no | RFC 3339 time bounds of that slice |

`records` MUST be a positive integer: an attestation over a run that left no
evidence is a statement with no subject, and an emitter MUST fail rather than
emit one. Problem code: `run-records-invalid`.

### 4.7 `auditChain` (mapping)

The hash-chained trail this record cites.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `head` | string | yes | Lowercase 64-hex SHA-256: the chain head at emission |
| `path` | string | no | Where the trail lived on the emitting host |
| `segments` | integer | no | How many rotated segments the head covers |
| `totalRecords` | integer | no | Total record count across those segments |

`head` MUST match `^[0-9a-f]{64}$`. Problem code: `audit-chain-head-invalid`.

An emitter MUST NOT emit a record over a trail that fails its own chain
verification. A verifier cannot check this — it does not have the trail — which
is exactly why it is an emitter MUST, and why §10 tells readers to check the
head against an independent copy.

### 4.8 `boot` (mapping)

Which boot of which image is being attested. A record that cannot name one boot
is a record about "some container".

| Key | Type | Required | Meaning |
|---|---|---|---|
| `bootId` | non-empty string | yes | Identifies the single boot these measurements came from |
| `imageDigest` | non-empty string | yes | Content identity of the image, or the literal `"unknown"` |
| `containerName` | string | no | Host-side name of the instance |
| `imageTag` | string | no | Human-facing tag, which is not an identity |
| `runtime` | string | no | The container runtime, when not the daemon default |

Problem codes: `boot-id-missing`, `image-digest-missing`.

`imageDigest` is required *including* its unknown case, and `"unknown"` is a
conforming value. An emitter that could not determine the image identity MUST
say so out loud rather than omit the field, because an absent field reads as an
oversight and `"unknown"` reads as a fact — which it is.

### 4.9 `enforcement` (mapping)

The measurements and the verdict they imply. This is the substance of the
record; §5 defines the relationship between its parts.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | `ACTIVE` \| `NOT_ENFORCED` \| `UNDETERMINED`. **Derived** (§5.2) |
| `rulesetReports` | sequence | yes | Per-application enforcement measurement, possibly empty |
| `doctorProbe` | mapping | yes | Independent behavioural probe of the host mechanism |
| `reasons` | sequence of strings | no | Human-readable account of a non-`ACTIVE` verdict |

Problem codes: `enforcement-missing` (the mapping itself),
`enforcement-status-invalid` (not one of the three words),
`ruleset-report-invalid`, `doctor-probe-invalid`,
`enforcement-status-underived` (§5.3).

`reasons` is advisory. A verifier MUST NOT derive a verdict from it or reject a
record for its contents: it is a rendering of the measurements, and the
measurements are what count.

#### 4.9.1 `rulesetReports[]`

Each entry:

| Key | Type | Required | Meaning |
|---|---|---|---|
| `app` | string | yes | Which application the measurement is about |
| `ruleset` | string | yes | What the enforcement mechanism reported. `"FullyEnforced"` is the only value meaning *fully enforced* |
| `bootId` | string | yes | The boot this measurement came from |
| `timestamp` | number | no | When it was measured |

`ruleset` is deliberately an open string, not an enum. Implementations enforce
with different mechanisms that report in different vocabularies, and forcing
them through a common enum would either lose information or invent it. The
derivation rule (§5.2) needs only one distinction: exactly `"FullyEnforced"`,
or anything else.

**Every entry's `bootId` MUST equal `boot.bootId`.** A verifier MUST report
`boot-id-inconsistent` otherwise. Without this rule a record can attest a boot
that did not enforce while carrying an enforcing boot's measurements — the
single most attractive forgery this format permits, and the only one a verifier
holding nothing but the record can actually catch. An emitter MUST filter
measurements by boot ID rather than collecting whatever the log contains.

An empty `rulesetReports` is well-formed and derives `UNDETERMINED` (§5.2). It
is not an error, and it MUST NOT derive `ACTIVE`.

#### 4.9.2 `doctorProbe`

| Key | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | `enforcing` \| `present_not_enforcing` \| `unsupported` \| `unknown` |
| `reason` | string | no | Why |

This is the *second, independent* measurement, and its independence is the
design: `rulesetReports` is what the enforcing software says about itself,
while the probe is a behavioural test of whether the underlying mechanism
actually refuses anything on this host. `ACTIVE` requires both, because either
one alone is a component grading its own homework.

`present_not_enforcing` is the value that earns the vocabulary: a mechanism can
be compiled in, advertised, and inert. Collapsing it into `unsupported` would
lose the distinction between *absent* and *lying*, and collapsing it into
`enforcing` would be the lie.

### 4.10 `policies` (sequence)

Which policy bytes were actually enforced. Each entry:

| Key | Type | Required | Meaning |
|---|---|---|---|
| `sha256` | string | yes | Lowercase 64-hex digest of the policy as enforced |
| `app` | string | no | Which application |
| `path` | string | no | Where the file lived, on the enforcing side |

The sequence MUST be present and MAY be empty. Every entry's `sha256` MUST
match `^[0-9a-f]{64}$`. Problem code: `policy-digest-invalid` for a missing
sequence or any malformed entry.

The digest MUST be computed over the bytes the enforcement mechanism *read*,
not over the source document a human wrote. Those differ whenever anything
grants, expands, or rewrites policy between authoring and enforcement, and the
enforced bytes are the ones that describe the run.

### 4.11 `recordSha256` (string)

Lowercase 64-hex, per §3.2. Problem code: `digest-mismatch`.

---

## 5. Measurements, and the derivation of a verdict

### 5.1 Measurements are inputs, carried in-band

A conforming record carries the measurements a verdict was computed from, not
just the verdict. This is the structural decision the whole format rests on:
it makes the verdict *recomputable* by a stranger, which turns
"`status` was edited" from an unfalsifiable suspicion into a check that runs
offline in microseconds.

The corollary is a MUST: an emitter MUST NOT publish a verdict that depends on
a measurement it did not include.

### 5.2 The derivation function

`derive(rulesetReports, doctorProbe) -> status` is defined as:

1. If `doctorProbe.status` is `unsupported` or `present_not_enforcing`, the
   result is **`NOT_ENFORCED`**.
2. Otherwise, if any entry of `rulesetReports` has `ruleset` other than
   exactly `"FullyEnforced"`, the result is **`NOT_ENFORCED`**.
3. Otherwise, if `doctorProbe.status` is `unknown`, the result is
   **`UNDETERMINED`**.
4. Otherwise, if `rulesetReports` is empty, the result is **`UNDETERMINED`**.
5. Otherwise the result is **`ACTIVE`**.

As a truth table, with *"reports"* meaning "at least one entry, all exactly
`FullyEnforced`":

| `doctorProbe.status` | no reports | reports, all `FullyEnforced` | any report not `FullyEnforced` |
|---|---|---|---|
| `enforcing` | `UNDETERMINED` | **`ACTIVE`** | `NOT_ENFORCED` |
| `unknown` | `UNDETERMINED` | `UNDETERMINED` | `NOT_ENFORCED` |
| `present_not_enforcing` | `NOT_ENFORCED` | `NOT_ENFORCED` | `NOT_ENFORCED` |
| `unsupported` | `NOT_ENFORCED` | `NOT_ENFORCED` | `NOT_ENFORCED` |

Three properties of this table are normative, not incidental:

- **Measured non-enforcement beats everything.** A boot that did not enforce is
  not enforced, whatever the host was capable of. Step 1 precedes step 2 and
  both precede any path to `ACTIVE`.
- **Missing evidence is never `ACTIVE`.** Absence produces `UNDETERMINED`, a
  third word that exists specifically so that "we could not tell" is sayable.
  An implementation with only two verdicts will eventually spell one of them
  optimistically.
- **`ACTIVE` requires both measurements to agree.** Neither the self-report nor
  the probe can reach it alone.

A verifier that does not implement `UNDETERMINED` does not conform. A verifier
MUST implement `derive` exactly; it MUST NOT add mechanisms, thresholds, or
allowances of its own.

### 5.3 Verdicts MUST be derived, never asserted

A verifier MUST recompute `derive(...)` over the record's own
`rulesetReports` and `doctorProbe` and compare it to `enforcement.status`,
reporting `enforcement-status-underived` on any disagreement.

This is what makes the format worth having. Editing `status` from
`NOT_ENFORCED` to `ACTIVE` and recomputing `recordSha256` produces a record
whose digest is perfectly valid and which every conforming verifier rejects
anyway, because the measurements still say what they said. Forging the
*measurements* remains possible for whoever controls the emitting host — that
is §10, and no amount of format design fixes it.

When `doctorProbe.status` is malformed (§4.9.2), a verifier MUST report
`doctor-probe-invalid` **and** perform the derivation comparison with the probe
treated as `unknown`, so that a record cannot reach `ACTIVE` by making a
measurement unreadable. Likewise a malformed `rulesetReports` sequence is
treated as empty for derivation. Malformed input MUST NOT be a path to a
stronger verdict.

### 5.4 Enforcement tiers

A record MAY carry a per-capability enforcement tier table under the OPTIONAL
`tiers` field. If present, it MUST use the vocabulary of Capability Manifest
1.0.0 §5.1 — `kernel`, `broker`, `recorded`, `unenforced` — with those
meanings, and MUST NOT report a capability above its weakest link.

The two vocabularies answer different questions and MUST NOT be conflated: a
tier says *what kind of thing stands behind a capability, in general*; a
`status` says *whether it stood behind this boot*. A `kernel`-tier capability
in a boot that measured `NOT_ENFORCED` is not a contradiction — it is the
mechanism being absent that day, and it is precisely the case the record
exists to make visible.

---

## 6. The verifier algorithm

A conforming verifier, given a decoded record, MUST perform all of the
following and collect every failure. The steps are independent: a failure in
one MUST NOT skip another, except where a step's input is structurally absent.

1. **Shape.** For each field in §4, in any order: check presence, type, and
   format, reporting that field's problem code. Includes `schemaVersion`,
   `kind`, `trustModel`, `generatedAt`, `runId`, `run.records`,
   `auditChain.head`, `boot.bootId`, `boot.imageDigest`, every
   `policies[].sha256`, `enforcement.status`, every `rulesetReports[]` entry,
   and `doctorProbe.status`.
2. **Boot consistency.** Every `rulesetReports[].bootId` equals `boot.bootId`
   (§4.9.1) → `boot-id-inconsistent`.
3. **Integrity.** Recompute §3.2 over the record with `recordSha256` removed;
   compare to `recordSha256` → `digest-mismatch`.
4. **Consistency.** Recompute §5.2 and compare to `enforcement.status`
   (§5.3) → `enforcement-status-underived`.

The record is **valid** iff no problem was reported.

A verifier MUST NOT weight, rank, or downgrade problems: there is no
"warning" tier. A record either conforms or it does not, and an implementation
that ships a category of failure it continues past has re-invented the thing
this format was built to prevent.

---

## 7. Errors

A verifier MUST report each failure with a `code` from this closed vocabulary.
The `message` is free prose for a human and is never matched on.

| Code | Reported when |
|---|---|
| `schema-version-unsupported` | `schemaVersion` absent, or a version this verifier does not implement (§4.1) |
| `kind-invalid` | `kind` is absent or not the expected constant (§4.2) |
| `trust-model-missing` | `trustModel` absent, not a string, or empty (§4.3) |
| `generated-at-invalid` | `generatedAt` absent or not an RFC 3339 date-time (§4.4) |
| `run-id-missing` | `runId` absent, not a string, or empty (§4.5) |
| `run-records-invalid` | `run.records` absent or not a positive integer (§4.6) |
| `audit-chain-head-invalid` | `auditChain.head` absent or not 64 lowercase hex (§4.7) |
| `boot-id-missing` | `boot.bootId` absent, not a string, or empty (§4.8) |
| `image-digest-missing` | `boot.imageDigest` absent, not a string, or empty (§4.8) |
| `policy-digest-invalid` | `policies` is not a sequence, or an entry's `sha256` is not 64 lowercase hex (§4.10) |
| `digest-mismatch` | `recordSha256` absent or not equal to the recomputed digest (§3.2) |
| `enforcement-missing` | `enforcement` absent or not a mapping (§4.9) |
| `enforcement-status-invalid` | `enforcement.status` is not one of the three verdict words (§4.9) |
| `ruleset-report-invalid` | `rulesetReports` is not a sequence, or an entry lacks `app`, `ruleset`, or `bootId` (§4.9.1) |
| `doctor-probe-invalid` | `doctorProbe.status` is not one of the four probe words (§4.9.2) |
| `boot-id-inconsistent` | A `rulesetReports[]` entry cites a different boot than `boot.bootId` (§4.9.1) |
| `enforcement-status-underived` | `enforcement.status` is not what §5.2 derives from the record's own measurements (§5.3) |

A conforming verifier MUST NOT invent codes outside this table for conditions
the table covers. It MAY define additional codes, prefixed with `x-`, for
conditions this specification does not define; such codes MUST NOT be the sole
reason a record defined as valid here is rejected.

---

## 8. Conformance

### 8.1 What conformance means

An implementation conforms to version 1.0.0 of this specification if it:

1. Produces the required outcome for every case in
   [`conformance/cases.json`](./conformance/cases.json) whose tag it is
   required to support (§8.4);
2. Emits records carrying a `trustModel` that meets §4.3's three-point minimum;
   and
3. Documents its `kind` constant, its `schemaVersion`, and any `x-` codes or
   extension fields it defines.

Passing the suite is **necessary, not sufficient**, and the gap is larger here
than for a syntax specification. The suite can prove that a verifier rejects an
edited record and recomputes a verdict correctly. It cannot prove that the
measurements a record carries were honestly obtained, that a `doctorProbe`
result came from a probe that actually probes anything, or that a `trustModel`
paragraph is true. Those need the implementation's own tests, with negative
controls, on real hosts — a separate discipline this specification requires an
implementation to describe and does not attempt to verify.

### 8.2 The adapter protocol

The suite is transport-agnostic and language-agnostic. An implementation
supplies an **adapter**: any executable program that

- reads **one JSON request object per line** on stdin (JSON Lines, UTF-8), and
- writes **one JSON response object per line** on stdout, in the same order,

flushing each line as it goes, and exiting 0 when stdin closes. Anything the
adapter writes to stderr is diagnostic and is captured but not interpreted.

Four operations, each carrying an `id` echoed back on the response:

**`describe`** — `{"id": N, "op": "describe"}`
```json
{"id": N,
 "implementation": "name/version",
 "specVersion": "1.0.0",
 "kind": "berth.attestation",
 "recordSchemaVersion": 1,
 "codes": ["digest-mismatch", "..."]}
```
`codes` is the subset of §7 this verifier implements. A verifier that does not
list a code is not excused from the cases that expect it — the field lets the
runner report an informative failure instead of an opaque one.

**`verify`** — `{"id": N, "op": "verify", "record": <mapping>}`
Response: `{"id": N, "valid": true}` or
`{"id": N, "valid": false, "problems": [{"code": "...", "message": "..."}]}`.

**`derive`** — `{"id": N, "op": "derive", "rulesetReports": [...], "doctorProbe": {...}}`
Response: `{"id": N, "status": "ACTIVE"|"NOT_ENFORCED"|"UNDETERMINED"}`.
Exercises §5.2 directly, so a derivation bug is reported as a derivation bug
rather than surfacing as a confusing verdict mismatch three cases later.

**`digest`** — `{"id": N, "op": "digest", "record": <mapping>}`
Response: `{"id": N, "sha256": "<64 lowercase hex>"}`.
The canonical digest of §3.2 over the record as given, with any `recordSha256`
entry removed. This is how §3.1 is tested at all: two implementations agreeing
on a hex string agree on every byte of canonicalization.

An adapter MUST answer all four.

### 8.3 Running the suite

```
node conformance/run.mjs --adapter "<command to run the adapter>"
```

Cases are built from named base records in the corpus, mutated by a `patch`
(deep merge; a `null` leaf deletes the key). Cases marked `"seal": true` are
re-sealed before verification using the digest **the adapter itself** returns
for the patched record, so that a shape case never fails for a canonicalization
reason and a canonicalization bug shows up only in `digest` cases where it
belongs. Cases marked `"seal": false` — every tamper case — are sent exactly as
built.

The runner sends every applicable case, compares, and exits non-zero on any
failure, printing each failure with its case id, the expectation, and what the
adapter answered. It reports skipped cases and why; **a skipped case is never
counted as a pass**.

For an invalid-expecting case, the runner requires that the adapter reported
`valid: false` **and** that every code the case names appears among the
reported problems. Extra codes are permitted (§2.3): a verifier that notices
more than the case demands has not failed it.

### 8.4 Levels

- **Core** (REQUIRED) — cases tagged `core`: field shape, the error contract,
  boot consistency, digest integrity, and the tamper cases.
- **Derivation** (REQUIRED) — cases tagged `derivation`: the whole of §5.2's
  truth table, plus the malformed-input paths of §5.3.
- **Canonical** (REQUIRED) — cases tagged `canonical`: `digest` against fixed
  expected hex, covering key ordering, absent-vs-present entries, nesting,
  escapes, and number forms.
- **Extended** (OPTIONAL) — cases tagged `extended`: optional fields, the
  `tiers` table (§5.4), and unknown-field handling. An implementation that does
  not support an optional field MAY skip its extended cases and MUST say so in
  its conformance report; it may not skip a `core` case for the same reason.

An implementation that passes core + derivation + canonical MAY state:
*"conforms to Attestation Record 1.0.0 (core, derivation, canonical)"*. Only
one that passes all four MAY state *"conforms to Attestation Record 1.0.0"*
unqualified.

### 8.5 The suite must be falsifiable

A conformance suite that no implementation can fail proves nothing. This one
ships a deliberately non-conforming adapter,
[`conformance/adapters/broken.mjs`](./conformance/adapters/broken.mjs), which
trusts the stated verdict instead of deriving it, treats an empty measurement
set as `ACTIVE`, accepts reports from any boot, canonicalizes with
`JSON.stringify` in insertion order, makes `trustModel` optional, and reports
problems without codes. The self-test
(`conformance/selftest.mjs`) requires the reference adapter to pass **and** the
broken adapter to fail, and fails if either expectation is not met.

An implementer adding cases SHOULD extend the broken adapter to violate them
too.

---

## 9. Emitter requirements

Most of this document constrains verifiers, because verifiers are what a
stranger runs. Four requirements fall on emitters, and none of them is
checkable by the suite — they are stated here so that "we conform" has a
meaning on the writing side too.

An emitter:

1. MUST NOT emit a record over an audit trail that fails its own chain
   verification (§4.7).
2. MUST NOT emit a record for a run with no evidence in that trail (§4.6).
3. MUST filter measurements to the attested boot (§4.9.1).
4. SHOULD run a conforming verifier over its own output before returning it,
   and MUST NOT return a record its own shipped verifier rejects.

The fourth is cheap and catches the whole class of bugs where an emitter and
its verifier drift apart while both remain internally consistent.

---

## 10. Security considerations

**The record is not a signature, and this is the sentence to reread.** Nothing
in this format involves keys. `recordSha256` detects edits; it identifies no
author. Anyone who can run the emitter can produce an unlimited number of
valid records saying whatever they like.

**Everything was measured by the host being attested.** The audit trail, the
container logs, the policy bytes, the probe — all of it was read by software
running where the operator has root. An operator who wants a favourable record
does not edit one; they rewrite the inputs and emit a fresh record that
verifies perfectly. This format detects the *lazy* forgery and is completely
transparent to the *thorough* one. §4.3 exists so that every record says this
about itself.

**The record becomes evidence when its digest leaves the writer's reach.**
Post `recordSha256` and `auditChain.head` somewhere append-only that the
emitting operator does not control, and the record stops being a claim and
starts being a commitment: a later rewrite of the trail now contradicts a
published digest. Until then, tamper-*evident* is the whole of it. Readers
SHOULD do this, and this specification cannot make them.

**Derived verdicts are the one real defense.** §5.3 is what keeps a record from
being a free-text field with a hash on it. It costs an attacker the work of
forging consistent measurements rather than editing one word, and it means a
sloppy edit is caught by a verifier that has never seen the host and is
offline.

**Do not let malformed input buy a better verdict.** §5.3's rule — malformed
probe treated as `unknown`, malformed reports treated as empty — exists because
the natural implementation (skip the derivation check when the inputs look
wrong) hands an attacker a one-character bypass. Any conforming verifier must
degrade toward the weaker verdict, never away from it.

**The record is attacker-supplied input to the verifier.** It arrives as a file
from somewhere. A verifier MUST be total (§2.3) — no crash, no hang, no
unbounded recursion — because a verifier that can be made to fall over is a
verifier that can be made not to report.

**Not addressed in 1.0.0.** Signing and provenance; counter-signature or
transparency-log publication of the head; revocation; confidentiality of a
record's contents; and any binding to hardware roots of trust. Their absence is
a known limit, named here rather than left to be discovered.

---

## 11. Versioning of this specification

This specification carries its own semantic version, in
[`VERSION`](./VERSION), advanced independently of any implementation's release
number and independently of the [Capability Manifest
Specification](../capability-manifest/SPEC.md). An implementation states which
specification version it targets (`describe`.`specVersion`).

- **Patch** (1.0.x) — editorial only: wording, examples, added conformance
  cases that no conforming implementation could already fail.
- **Minor** (1.x.0) — additive: new optional fields, new problem codes for
  conditions previously undefined, new conformance cases in a new tag. A
  1.0.0-conforming verifier remains conforming to 1.x's core because unknown
  fields must be ignored (§2.2).
- **Major** (x.0.0) — anything that could make a previously valid record
  invalid, change what a field means, change the derivation table, or change
  canonicalization. The JCS divergence in §3.1 is the known candidate.

`schemaVersion` (§4.1) versions the *record shape*; this version numbers the
*document you are reading*. They move independently: a specification patch
changes no record, and a record-shape migration is an implementation event.

---

## Appendix A — a complete record

```json
{
  "schemaVersion": 1,
  "kind": "berth.attestation",
  "trustModel": "tamper-evident, not tamper-proof: this record and the audit chain it cites are hashed, but both were produced by software running on the attested host. Anyone who controls that host could have rewritten the chain wholesale and re-emitted this record before its head left their reach. The record proves internal consistency and detects after-the-fact edits; it does not prove the host told the truth at emission time.",
  "generatedAt": "2026-08-24T09:15:02.441Z",
  "runId": "run-4f2a9c",
  "run": { "records": 214, "firstSeq": 1180, "lastSeq": 1393 },
  "auditChain": {
    "path": "/var/lib/berth/audit.jsonl",
    "segments": 3,
    "totalRecords": 4021,
    "head": "9f2c1d7a3b5e8046c1d9f4a27b6e0358d2c9a1b4e7f036d5a8c2b9e14f7d0362"
  },
  "boot": {
    "bootId": "b-7c1e44",
    "containerName": "berth-os-default",
    "imageTag": "berth/os:0.1.0",
    "imageDigest": "sha256:3a7f...c19e",
    "runtime": "runsc"
  },
  "enforcement": {
    "status": "ACTIVE",
    "reasons": [],
    "rulesetReports": [
      { "app": "indexer", "ruleset": "FullyEnforced", "bootId": "b-7c1e44" },
      { "app": "assistant", "ruleset": "FullyEnforced", "bootId": "b-7c1e44" }
    ],
    "doctorProbe": { "status": "enforcing" }
  },
  "policies": [
    { "app": "indexer", "path": "/app/.berth/capability-policy.json",
      "sha256": "1c4b8e0a5d3f7962b1e8c0a4d7f36529b8e1c4a70d3f6952b8e1c4a70d3f6952" }
  ],
  "recordSha256": "<sha256 of the canonical form of everything above>"
}
```

Change `doctorProbe.status` to `present_not_enforcing` and the same document is
required to say `NOT_ENFORCED`. That is the whole feature.

## Appendix B — reference implementations

There are two, deliberately:

- `scripts/verify-attestation.mjs` — standalone, depending on nothing but
  `node:crypto`, so a stranger can check a record without installing anything.
- `verifyAttestation` in `@berthos/audit` — the same algorithm as a library,
  used by the emitter to check its own output (§9.4).

The conformance suite runs the same corpus through both
([`conformance/adapters/berth.mjs`](./conformance/adapters/berth.mjs),
`--impl standalone|library`), which is how the two are kept from drifting.

Being the reference confers no authority: where an implementation and this
document disagree, the document is right and the implementation has a bug.
