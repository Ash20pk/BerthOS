# The Capability Manifest Specification

**Version 1.0.0** — status: **stable**. Versioned independently of any
implementation; see [§10 Versioning](#10-versioning-of-this-specification).

A capability manifest is a declarative document in which an *application* —
typically an AI agent or an agent-adjacent worker — states, ahead of running,
every resource family it intends to touch. A conforming *runtime* reads that
document and constrains the application to it.

This document defines the manifest's syntax, its semantics namespace by
namespace, the enforcement-tier vocabulary a conforming implementation MUST
publish alongside it, the compatibility rules that govern change, and a
conformance suite that decides whether an implementation conforms.

It is written so that an implementer who has never seen the reference
implementation can build a conforming one from this text plus
[`conformance/cases.json`](./conformance/cases.json).

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL are to be interpreted as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they
appear in all capitals.

---

## 1. Scope and non-goals

**In scope.** The manifest document: what a well-formed one looks like, what
each field means, which documents a conforming implementation MUST accept and
which it MUST reject, how a granted capability is matched against a requested
one, and how an implementation MUST describe the strength of its own
enforcement.

**Explicitly not in scope.** *How* a runtime enforces anything. This
specification never requires Landlock, seccomp, a proxy, a hypervisor, a
language-level check, or any other mechanism. Two conforming implementations
may enforce the same manifest at wildly different strengths — that is expected,
and it is precisely why §5's tier declaration is mandatory. A manifest is a
statement of intent; the tier table is the honest account of what an
implementation does with it.

Also out of scope: the transport by which a manifest reaches a runtime, image
building, deployment, and the manifest's relationship to any particular
programming language or SDK.

---

## 2. Document model

### 2.1 Serialization

A manifest is a mapping. Its canonical serialization is YAML 1.2
(conventionally a file named `berth.yml`), and every conforming implementation
MUST accept YAML 1.2. Because the data model below is a strict subset of JSON,
an implementation MAY additionally accept JSON, TOML, or an in-memory mapping;
acceptance MUST NOT depend on the serialization chosen.

The data model uses only: mappings with string keys, sequences, strings,
integers, finite non-integer numbers, and booleans. `null` is not part of the
model: an explicit `null` for any field defined below MUST be rejected rather
than treated as absent. (Absent and `null` differing is deliberate — a field
someone wrote out and left empty is more likely a mistake than an intent.)

Unicode: field values are Unicode strings. A string field MUST NOT contain a
NUL (U+0000); implementations MUST reject a manifest that contains one anywhere
it is not explicitly permitted (it is permitted nowhere in this version).

### 2.2 Unknown fields

An implementation MUST accept a manifest containing top-level fields this
specification does not define, and MUST ignore them for the purposes of
validation and enforcement. Unknown fields are how out-of-band extensions and
future additive fields travel through an older implementation without breaking
it.

An implementation MUST NOT grant any capability, expose any port, or otherwise
change enforcement on the basis of a field this specification does not define
**unless** that behavior is declared in its tier table (§5.4) as an
implementation extension.

### 2.3 Validation outcome

Validation of a manifest yields exactly one of:

- **valid** — with a *normalized* manifest (§4.11) as its result; or
- **invalid** — with at least one *error*, each carrying a `path`: the sequence
  of field names and array indices locating the offending value (e.g.
  `["capabilities", 2]`). A conforming implementation MUST report the path of
  each error and SHOULD report a source line where the serialization allows it.

Validation MUST be total: every input either validates or produces errors. An
implementation MUST NOT crash, hang, or partially apply a manifest that fails
validation.

---

## 3. Capability strings

### 3.1 Grammar

```
capability = namespace ":" action ":" scope
namespace  = 1*( %x61-7A / DIGIT / "_" / "-" )      ; lowercase a-z, 0-9, _, -
action     = 1*( %x61-7A / DIGIT / "_" / "-" )      ; same
scope      = 1*VCHAR-ish                            ; one or more characters, any
```

Concretely: a capability string MUST match

```
^[a-z0-9_-]+:[a-z0-9_-]+:.+$
```

The scope is everything after the **second** colon, and MAY itself contain
colons — `network:connect:127.0.0.1:8080` parses as namespace `network`,
action `connect`, scope `127.0.0.1:8080`. Parsing MUST split on the first two
colons only.

A string with fewer than two colons, an empty namespace, an empty action, or an
empty scope is invalid. Namespace and action are case-sensitive and MUST be
lowercase; `GitHub:read:repos` is invalid, not a case-insensitive alias.

### 3.2 Matching

`matches(granted, requested)` decides whether an application holding `granted`
may perform `requested`. It MUST be computed as:

1. Parse both per §3.1. If either fails to parse, the result is `false`.
2. If `granted.namespace != requested.namespace`, the result is `false`.
   Namespace matching is exact; `*` in a namespace is not a wildcard.
3. If `granted.action != requested.action`, the result is `false`. Action
   matching is exact, for the same reason.
4. Otherwise the result is whether `granted.scope` matches `requested.scope`
   as a glob, defined in §3.3.

Matching is not symmetric: `matches("browser:navigate:*", "browser:navigate:a.com")`
is `true` and the reverse is `false`.

### 3.3 Scope globs

Within a scope, `*` matches zero or more characters, including `/` and `.`.
Every other character matches itself literally, including `?` and `[`, which
have no special meaning. A scope MAY contain any number of `*`.

Formally: the granted scope is converted to an anchored regular expression by
escaping every regex metacharacter, then replacing each escaped `*` with `.*`,
then anchoring with `^` and `$`. The requested scope matches iff that
expression matches it in full.

Consequences implementers get wrong and the conformance suite checks:

- `*.github.com` matches `api.github.com`; it does **not** match `github.com`
  (no leading dot to consume) and it **does** match `evil.com/x.github.com`
  when the scope is compared as a plain string — which is why §4.3's per-
  namespace semantics, not the glob alone, decide host authorization.
- `*` alone matches every scope, including the empty-ish and the colon-bearing.
- Matching is over the scope *string*. This specification defines no
  host-, path-, or port-aware comparison; a namespace that needs one MUST
  define it in its own semantics (§4.3) and MUST say so in its tier table.

### 3.4 Filesystem scopes are paths, not labels

For the `filesystem` namespace with action `read` or `write`, the scope is a
real path that a conforming runtime will act on — creating it, and granting
access beneath it — before the application starts. It is therefore constrained
beyond §3.1. A `filesystem:read:` or `filesystem:write:` scope MUST be rejected
unless all of the following hold:

1. It contains no NUL byte.
2. It is absolute — it begins with `/`.
3. After removing at most one trailing `/*`, the remainder contains no `*`.
   A trailing `/*` is the only glob with meaning here (grants beneath a path
   are recursive, so `/w` and `/w/*` denote the same grant); a `*` anywhere
   else is not a glob at the filesystem layer and would become a directory
   literally named `*`.
4. After that removal, the path is not `/`. A grant of `/` is the whole
   filesystem and MUST be rejected outright rather than silently honored.
5. After that removal, the path is canonical: splitting on `/` yields no empty
   segment, no `.`, and no `..`. This rejects `//w`, `/w/`, `/w/./x`, and
   `/w/../etc`.
6. It lies within the implementation's **filesystem scope allowlist**: the path
   equals an allowlist entry or begins with an allowlist entry followed by `/`.

An implementation MUST publish its allowlist. The reference allowlist, which a
conforming implementation SHOULD adopt unless it has a documented reason not
to, is:

```
/workspace   the application's working tree
/context     shared context storage, where the implementation provides it
/tmp         scratch
/app         a single-application container's own directory
```

An implementation with a different allowlist remains conforming, but MUST
declare it, and MUST still reject every path failing rules 1–5. Conformance
cases that depend on the allowlist are tagged `allowlist-dependent` and are
evaluated against the allowlist the implementation reports (§7.3).

Rule 6 is not cosmetic. Because the runtime creates the path with elevated
privilege before enforcement exists, an unconstrained scope turns a manifest —
one that may have arrived from a registry or a pull request — into a request to
create and grant write access to an arbitrary location.

### 3.5 Declaration is not permission

A capability appearing in a manifest is an application's *request*. Nothing in
this specification requires an implementation to grant it. An implementation
MAY refuse to run an application whose declarations exceed a local policy, MAY
grant a subset, and MUST report what it actually granted (§5.3) rather than
echoing the declaration.

---

## 4. Fields

Each subsection gives the field's type, default, and semantics. A default is
applied during normalization (§4.11); an absent field with a default MUST
behave identically to the field written out with that default value.

### 4.1 `name` (REQUIRED)

String matching `^[a-z0-9-]+$`. The application's identity within its runtime:
implementations use it for image naming, per-application isolation, and
addressing between applications. It MUST NOT be empty and MUST NOT contain
uppercase letters, underscores, dots, or slashes.

### 4.2 `version` (REQUIRED)

String matching `^\d+\.\d+\.\d+$` — three dot-separated non-negative integers.
The application's own version. It is unrelated to `schema_version` (§4.10) and
unrelated to this specification's version. Pre-release and build metadata
(`1.0.0-rc.1`, `1.0.0+build`) are **not** accepted in this version of the
specification.

### 4.3 `capabilities` (default `[]`)

A sequence of capability strings (§3). Each entry MUST satisfy §3.1, and each
`filesystem:read:`/`filesystem:write:` entry MUST additionally satisfy §3.4.
Errors MUST be reported per entry index, not for the sequence as a whole.

Duplicate entries are permitted and MUST be treated as one declaration; an
implementation MAY deduplicate during normalization but MUST NOT reject.

The order of entries carries no meaning. This specification defines no
precedence, negation, or subtraction: there is no way to write "everything
under `/workspace` except `/workspace/secrets`". A manifest is a union of
grants, and an implementation MUST NOT invent an ordering rule.

**Registered namespaces.** The following namespaces are registered by this
specification. An implementation MAY support any subset, MAY support additional
namespaces, and MUST declare in its tier table (§5) which it supports and at
what tier.

| Namespace | Actions | Scope means | Notes |
|---|---|---|---|
| `filesystem` | `read`, `write` | an absolute path (§3.4) | `write` conventionally implies create/delete/rename/truncate beneath the path; it does not imply `read`, and neither implies execute |
| `network` | `connect` | a destination port as a decimal 1–65535, or `*` for unrestricted | scope is a **port**, not a host; host-level authorization belongs to a broker and MUST be declared at broker tier |
| `network` | `peer` | the name of another application, or a glob over names | peering SHOULD require mutual declaration: two applications reach each other only when each names the other |
| `app` | `invoke` | the name of another application in the same runtime | a connect-time gate over the target's whole export surface — it says *who may call*, not *which export*; an implementation MUST NOT present it as per-export authorization |
| `github` | `read`, `write` | a resource family (e.g. `repos`, `issues`) | a broker-tier namespace by nature: enforcement means a process on the API path |
| `browser` | `navigate`, `screenshot` | a host glob, for `navigate` | `navigate` is enforceable at broker tier; `screenshot` has no denial semantics and is recorded-tier by nature |
| `terminal` | `attach` | an identifier, or `*` | grants interactive access to the application's own process space |

An implementation encountering a capability in a registered namespace with an
action this specification does not register MUST treat it as an unrecognized
capability: it is syntactically valid and MUST NOT fail validation, and it MUST
NOT silently widen anything. An unrecognized capability MUST be reported as
recorded-tier or refused; it MUST NOT be reported as enforced.

Unregistered namespaces are permitted, and are how the vocabulary grows. An
implementation MUST treat an unregistered namespace exactly as the previous
paragraph requires.

### 4.4 `description` (default `""`)

A short human-readable summary. Carries no enforcement meaning.

### 4.5 `exports` (default `[]`)

A sequence of export descriptors, each a mapping:

- `name` (REQUIRED) — string, the callable's name.
- `input` (OPTIONAL) — a flat mapping of parameter name to a type name from
  `string | number | boolean | object | array`.
- `output` (OPTIONAL) — same shape.

Nested type structure is deliberately not expressible in this version;
`object` and `array` are opaque. An implementation MUST reject a type name
outside the five listed, and MUST reject a non-mapping `input`/`output`.

An implementation SHOULD verify at startup that the application's implemented
exports match this list exactly, and SHOULD treat a mismatch as a startup
failure rather than a warning: tooling that trusts the manifest is only safe if
the manifest is checked against the code.

### 4.6 `expose` (default `{ browser: true, terminal: true, preview: false }`)

A mapping of booleans deciding whether a declared `browser`/`terminal`
capability additionally causes a viewing surface to be published:

- `browser` — publish a browser-viewing port on a local development run.
- `terminal` — publish a terminal port on a local development run.
- `preview` — create a reachable preview URL on a **deployed** target.

Capability and exposure are separate decisions: an application may hold
`browser:navigate:*` with `browser: false` and still navigate, unwatched.

`preview` MUST default to `false` even though the other two default to `true`.
A deployed target is potentially public, so declaring a capability MUST NOT by
itself cause a publicly reachable interactive URL to exist. An implementation
that publishes a preview URL by default does not conform.

`preview: true` with no corresponding capability declared is a no-op, not an
error.

### 4.7 `governs` (default `false`)

Declares this application as its runtime's governance authority: other
applications' actions are routed through this application's `evaluate_action`
export for an allow/deny verdict before proceeding.

An implementation MUST reject a manifest with `governs: true` that does not
declare an export named `evaluate_action`; the error path is `["governs"]`.

At most one application per runtime may declare `governs: true`; an
implementation MUST fail at composition time if more than one is loaded. That
check is outside a single manifest's validation, so it is not part of the
conformance suite.

Governance is broker tier by construction — it is a process making a decision,
not a kernel refusing a syscall — and an implementation MUST declare it as
such, including its behavior when the authority errors or times out.

### 4.8 `governance` (default `{ exempt: false }`)

`exempt: true` opts this application out of the gate described in §4.7. It has
no effect when no governance authority is loaded. Default `false`: an
application is governed by default once an authority exists, because an opt-in
gate is not a gate.

### 4.9 `resources` (default `{}`)

Optional sizing hints: `cpu` (a positive number of fractional cores),
`memory_mb` (a positive integer, MiB), `gpu` (a positive integer count). Each
key is independent; an absent key requests nothing, which is not the same as
requesting zero.

Enforcement is best-effort and target-dependent. An implementation MUST state,
per target, whether each key becomes a hard limit or is passed through
unenforced, and MUST NOT describe an unenforced pass-through as a limit.

### 4.10 `schema_version` (default: the implementation's current version)

A non-negative integer naming the version of the *manifest shape* this document
was written against. It is metadata about the file, not part of the validated
content, and MUST be resolved before the rest of validation runs.

- **Absent** — treated as the implementation's current version, never as
  version 0. Every manifest written before the field existed MUST keep
  validating exactly as it did.
- **Older than current** — the implementation MUST walk the document forward
  through its registered migrations, one version at a time, then validate the
  result against the current shape. If any step in that walk has no registered
  migration, the implementation MUST fail with an error naming the missing
  step. It MUST NOT pass the document through unchanged.
- **Newer than current** — the implementation MUST fail with an error saying so
  and directing the reader to upgrade. Validating a document against a shape it
  was never written for is the precise failure this field exists to prevent.
- **Not a non-negative integer** — invalid (`3.5`, `"1"`, `-1`, `null`).

### 4.11 Normalization

The normalized form of a valid manifest is the manifest with every defaulted
field present at its default value, and `schema_version` resolved and removed.
Two manifests with the same normalized form MUST be enforced identically.

Normalization MUST NOT reorder `capabilities` or `exports` in a way that
changes their reported content, and MUST NOT rewrite a scope — a trailing
`/*` is stripped when compiling a policy, not when normalizing a manifest.

An implementation MAY drop unknown top-level fields (§2.2) from the normalized
form and SHOULD make them visible to the caller some other way; the conformance
suite compares only the fields this specification defines, so both choices
conform. The reference implementation drops them.

---

## 5. Enforcement tiers

This is the part of the specification that is not about syntax, and the part
most easily skipped by an implementation that would rather not answer the
question.

### 5.1 The vocabulary

Every capability an implementation supports MUST be assigned exactly one tier:

| Tier | The claim | What a bypass means |
|---|---|---|
| **kernel** | The operating system refuses the action. Bypassing it requires defeating the OS mechanism, not the runtime. | A vulnerability, and the most serious class an implementation can have. |
| **broker** | A process on the request path refuses or rewrites it. Enforcement holds only while that process is unavoidably in the path. | A vulnerability, conditional on the broker actually being in the path. |
| **recorded** | Nothing is prevented. The action is detected and written to a record. | Not a boundary. Never to be described as one; the value is evidence. |
| **unenforced** | No mechanism stands here, by choice. | Expected — but a worse-than-documented reality is still a finding. |

An implementation MUST NOT invent intermediate tiers, and MUST NOT report a
capability at a tier stronger than its weakest link. A `filesystem:write:`
grant enforced by the kernel *and* checked by a library is kernel tier; a
`browser:navigate:` grant enforced by a proxy the application can decline to
use is **unenforced**, not broker, until the proxy is unavoidable.

### 5.2 The tier table is mandatory

A conforming implementation MUST publish a machine-readable tier table
covering every namespace and action it supports, in the shape defined in §7.3,
and MUST make it available programmatically (this is the conformance suite's
`tier` operation). An implementation that enforces perfectly but publishes no
tier table does not conform.

The reason is the whole point of this section. A manifest is portable; trust in
it is not. A reader who moves an application from one conforming runtime to
another needs a mechanical answer to "what actually stands behind this line
now," and an implementation that will not answer is indistinguishable from one
whose answer is embarrassing.

### 5.3 Reporting what was granted

An implementation MUST expose, to the running application or its operator, the
capabilities it actually granted and the tier of each. Where the granted set
differs from the declared set (§3.5), the difference MUST be reported rather
than silently dropped.

### 5.4 Extensions

An implementation MAY define additional namespaces, additional fields, and
additional behavior. Every extension MUST appear in the tier table, marked as
an extension. An extension MUST NOT change the meaning of anything this
specification defines: a conforming implementation and this document must never
disagree about what `filesystem:write:/workspace` means.

---

## 6. Errors

An implementation MUST reject, with at least one error, any manifest that:

1. Is not a mapping.
2. Omits `name` or `version`, or gives either a value of the wrong type.
3. Gives `name` or `version` a value failing its pattern (§4.1, §4.2).
4. Contains an explicit `null` for any field defined here.
5. Contains a `capabilities` entry that is not a string, or fails §3.1.
6. Contains a `filesystem:read:`/`filesystem:write:` entry failing §3.4.
7. Contains an `exports` entry without a `name`, or with an `input`/`output`
   naming a type outside the five of §4.5.
8. Sets `governs: true` without an `evaluate_action` export.
9. Gives `schema_version` a value that is not a non-negative integer, or that
   is newer than the implementation supports, or that is older with no
   registered migration path.
10. Gives a defined field a value of the wrong type (e.g. `capabilities` as a
    string, `expose` as a boolean under this version, `resources.cpu` as a
    string, a non-positive `resources` value).

An implementation MUST NOT reject a manifest merely for containing an unknown
top-level field (§2.2), an unregistered capability namespace (§4.3), or a
duplicate capability entry.

An error MUST carry a `path`. For a sequence entry the path MUST include the
integer index (`["capabilities", 2]`), so a reader is pointed at the line that
is wrong rather than at the block containing it.

---

## 7. Conformance

### 7.1 What conformance means

An implementation conforms to version 1.0.0 of this specification if it:

1. Produces the required outcome for every case in
   [`conformance/cases.json`](./conformance/cases.json) whose tag it is
   required to support (§7.4);
2. Publishes a tier table per §5.2 covering every namespace and action it
   supports; and
3. Documents its filesystem scope allowlist (§3.4) and any extensions (§5.4).

Passing the suite is necessary, not sufficient: the suite tests the manifest
contract, and can say nothing about whether an implementation's claimed kernel
tier is real. That claim needs the implementation's own denial tests with
controls, which is a separate discipline this specification requires an
implementation to describe but does not attempt to verify.

### 7.2 The adapter protocol

The suite is transport-agnostic and language-agnostic. An implementation
supplies an **adapter**: any executable program that

- reads **one JSON request object per line** on stdin (JSON Lines, UTF-8), and
- writes **one JSON response object per line** on stdout, in the same order,

flushing each line as it goes, and exiting 0 when stdin closes. Anything the
adapter writes to stderr is diagnostic and is captured but not interpreted.

Four operations, each carrying an `id` echoed back on the response:

**`validate`** — `{"id": N, "op": "validate", "manifest": <mapping>}`
Response: `{"id": N, "valid": true, "normalized": <mapping>}` or
`{"id": N, "valid": false, "errors": [{"path": [...], "message": "..."}]}`.
The `manifest` value is the already-parsed data model of §2.1; adapters are not
required to parse YAML. (An implementation's YAML acceptance is asserted by its
own tests, not by this suite, which has no way to hand a byte stream to an
arbitrary adapter.)

**`match`** — `{"id": N, "op": "match", "granted": "...", "requested": "..."}`
Response: `{"id": N, "matches": <boolean>}`.

**`tier`** — `{"id": N, "op": "tier", "namespace": "...", "action": "..."}`
Response: `{"id": N, "tier": "kernel"|"broker"|"recorded"|"unenforced"|"unsupported", "extension": <boolean, optional>}`.
`unsupported` means the implementation does not implement the capability at
all — distinct from `unenforced`, which means it is implemented and nothing
stands behind it.

**`describe`** — `{"id": N, "op": "describe"}`
Response:
```json
{"id": N,
 "implementation": "name/version",
 "specVersion": "1.0.0",
 "filesystemAllowlist": ["/workspace", "/context", "/tmp", "/app"],
 "schemaVersion": 1,
 "tiers": [{"namespace": "filesystem", "action": "write", "tier": "kernel"}, ...]}
```

An adapter MUST answer `describe` and `match`. An adapter MUST answer
`validate`. An adapter MUST answer `tier` for every namespace/action pair it
lists under `describe`.`tiers`, and MAY answer `unsupported` for others.

### 7.3 Running the suite

```
node conformance/run.mjs --adapter "<command to run the adapter>"
```

The runner sends every applicable case, compares, and exits non-zero on any
failure, printing each failure with its case id, the expectation, and what the
adapter answered. It reports skipped cases and why; a skipped case is never
counted as a pass.

Allowlist-dependent cases (§3.4 rule 6) are evaluated against the allowlist the
adapter reports in `describe`, so an implementation with a different allowlist
is judged against its own declaration rather than against the reference one.

### 7.4 Levels

- **Core** (REQUIRED) — every case tagged `core`: the grammar, matching,
  filesystem scope rules, required fields, error paths, defaults, and
  `schema_version` resolution.
- **Tiers** (REQUIRED) — every case tagged `tiers`: `describe` is well-formed,
  every listed tier is one of the four words, and every namespace/action listed
  answers `tier` consistently with `describe`.
- **Extended** (OPTIONAL) — cases tagged `extended`: governance, exports
  cross-checks, exposure defaults, and resources. An implementation that does
  not support a field MAY skip its extended cases, and MUST say so in its
  conformance report; it may not skip a `core` case for the same reason.

An implementation that passes core + tiers MAY state: *"conforms to Capability
Manifest 1.0.0 (core, tiers)"*. Only one that passes all three MAY state
*"conforms to Capability Manifest 1.0.0"* unqualified.

### 7.5 The suite must be falsifiable

A conformance suite that no implementation can fail proves nothing. This one
ships a deliberately non-conforming adapter,
[`conformance/adapters/broken.mjs`](./conformance/adapters/broken.mjs), which
accepts `filesystem:write:/`, mis-globs `*.example.com`, drops the `preview`
default to `true`, and reports a broker-tier mechanism as kernel. The suite's
self-test (`conformance/selftest.mjs`) requires the reference adapter to pass
**and** the broken adapter to fail, and fails if either expectation is not met.
An implementer adding cases SHOULD extend the broken adapter to violate them
too.

---

## 8. Security considerations

**The manifest is attacker-supplied input.** It arrives from a registry, a pull
request, or a generating model. Every rule in §3.4 exists because the runtime
acts on the document with more privilege than the application it constrains.
An implementation that treats manifest validation as a linting convenience,
rather than as a parser hardening boundary, has the security posture of its
weakest field.

**Declaration is a claim, not evidence.** An honest `capabilities` list makes
tooling useful; nothing in the format makes it honest. Enforcement must never
be derived from the manifest alone in a way that assumes good faith — the
manifest says what to *restrict to*, and a runtime that instead treats it as
what to *permit beyond* has inverted the contract.

**Tiers are a promise to readers.** The most dangerous thing an implementation
can do with this specification is publish a tier table that reads better than
its enforcement. A recorded-tier mechanism described as broker, or a broker the
application can route around described as kernel, converts a document meant to
create trust into a mechanism for laundering it.

**No negation, on purpose.** §4.3 forbids precedence and subtraction rules.
Deny-list semantics layered over allow-lists are the historical source of
policy-engine bypasses; a union of grants has one reading.

**Not addressed here.** Authenticity of the manifest (signing, provenance),
revocation of a granted capability at runtime, and per-export authorization
beneath `app:invoke` are all outside version 1.0.0. Their absence is a known
limit, not an oversight.

---

## 9. Relationship to the attestation record

A manifest states intent; an attestation record states what a specific run
actually enforced. They are separate documents with separate versions, joined
by the tier vocabulary of §5.1: a record that reports a capability as enforced
MUST use the same four words. The attestation record has its own
specification.

---

## 10. Versioning of this specification

This specification carries its own semantic version, in
[`VERSION`](./VERSION), advanced independently of any implementation's release
number. An implementation states which specification version it targets
(`describe`.`specVersion`).

- **Patch** (1.0.x) — editorial only: wording, examples, added conformance
  cases that no conforming implementation could already fail.
- **Minor** (1.x.0) — additive: new registered namespaces, new optional fields,
  new conformance cases in a new tag. A 1.0.0-conforming implementation remains
  conforming to 1.x's core if it ignores what it does not know (§2.2), and this
  is exactly why unknown fields must be ignored rather than rejected.
- **Major** (x.0.0) — any change that could make a previously valid manifest
  invalid, or change what a field means.

`schema_version` (§4.10) versions the *manifest shape* within an
implementation; this version numbers the *document you are reading*. They move
independently: a specification patch changes no manifest, and a manifest-shape
migration is an implementation event.

---

## Appendix A — a complete manifest

```yaml
name: github-assistant
version: 1.0.0
description: Opens issues and summarizes repositories.

capabilities:
  - github:read:repos
  - github:write:issues
  - filesystem:read:/workspace
  - filesystem:write:/workspace/out
  - network:connect:443
  - browser:navigate:*.github.com
  - app:invoke:indexer

exports:
  - name: create_issue
    input: { title: string, body: string }
  - name: get_repo_summary
    input: { repo: string }
    output: { summary: string, open_issues: number }

expose:
  browser: false
  terminal: true
  preview: false

resources:
  cpu: 0.5
  memory_mb: 512
```

Its normalized form adds `governs: false`, `governance: {exempt: false}`, and
the defaults for anything else absent.

## Appendix B — reference implementation

`@berth/manifest-schema` is the reference implementation of this document, and
its conformance adapter is
[`conformance/adapters/berth.mjs`](./conformance/adapters/berth.mjs). Being the
reference confers no authority: where the implementation and this document
disagree, the document is right and the implementation has a bug.
