# Writeup skeleton — "Your agent sandbox says enforcement is active. Says who?"

BUILD_PLAN rule 4: every M1+ task ships with a draft that could be published
as-is. This one is M3.2. Maintainer publishes; nothing below waits on an agent.

**Audience:** platform and security engineers who have to answer "was the
sandbox actually on?" for someone else — auditors, customers, their own
incident review. Secondarily anyone building an agent runtime that is about to
emit a JSON blob with the word `active` in it.

**One-line thesis:** a verdict field is worthless; a verdict you can recompute
from the evidence shipped beside it is worth something, and the difference is
about forty lines of specification.

---

## 1. The blob everyone is about to write

Every agent runtime that grows sandboxing grows a status endpoint. It says
something like:

```json
{ "sandbox": "enabled", "policy": "strict" }
```

Ask what would have to be true for that to be false, and there is no answer,
because there is nothing in the document that could contradict it. It is a
string. Somebody's code wrote the string. If the enforcement had silently failed
to load, the same code would have written the same string, because the string is
not connected to anything.

That is not a strawman. It is what you get by default, and it is what you keep
getting until someone decides the document has to carry its own evidence.

## 2. Carry the measurements, derive the verdict

[The Attestation Record Specification](https://github.com/Ash20pk/BerthOS/blob/main/spec/attestation-record/SPEC.md)
is a standalone document — its own version number, its own conformance suite,
implementable by anyone. The mechanical parts are unremarkable: canonical JSON,
a self-digest, RFC 3339 timestamps, an error-code vocabulary.

Two rules are the argument.

**§5.3 — the verdict must be derived, never asserted.** A record carries the raw
measurements: what each app's enforcement reported at boot, and an independent
behavioural probe of whether the host mechanism actually refuses anything. The
verdict is a pure function of those (§5.2), and a conforming verifier
*recomputes* it rather than reading it.

So editing `NOT_ENFORCED` to `ACTIVE` and recomputing the hash gets you a record
with a perfectly valid digest that every conforming verifier rejects anyway —
the measurements still say what they said. The attacker's cost goes from
one word to forging a consistent set of measurements. That is not security, but
it is the difference between a claim and a document.

**§4.3 — every record states its own trust model, in-band, or it does not
conform.** A required prose field saying what trusting *this record* requires:
tamper-evident or tamper-proof, who produced the measurements, what it does not
prove. Not a link. Not a doc site. In the JSON, next to the hash, where a reader
who has nothing else will see it.

*Draft note: §5.3 is the engineering; §4.3 is the argument. Lead with whichever
the venue rewards, but do not drop §4.3 for length — it is the part nobody else
is doing.*

## 3. The third verdict

There are three, not two: `ACTIVE`, `NOT_ENFORCED`, and **`UNDETERMINED`**.

A system with two verdicts has to spell "we could not tell" as one of them, and
it will not be the pessimistic one. The truth table in §5.2 is explicit that
missing measurements never reach `ACTIVE`, that a measured non-enforcement beats
everything the host was *capable* of, and that `ACTIVE` requires both the
self-report and the independent probe to agree — because either alone is a
component grading its own homework.

There is a matching rule that reads like paranoia and is not: malformed input
must degrade toward the *weaker* verdict. The natural implementation — skip the
derivation check when the measurements look wrong — hands an attacker a
one-character bypass.

## 4. Writing it down found a real bug

Berth had shipped this format already, with two verifiers: a standalone script
depending on nothing but `node:crypto`, and a library the emitter checks itself
with. Both correct, both tested.

Writing the verifier algorithm down as something a stranger must be able to
reimplement surfaced a hole neither had: **nothing compared the boot ID on each
measurement against the boot the record claims to attest.** The emitter always
filtered by boot ID, so no record we produced was ever wrong — but a record from
anyone else, or a hand-assembled one, could attest a boot where enforcement was
off while carrying a different boot's evidence, and verify perfectly. It is the
most attractive forgery the format permits and the only one a verifier holding
nothing but the record can actually catch.

It was invisible for as long as the emitter and the verifier were read as one
system. Specifying the verifier alone is what made it visible.

*Draft note: this is the section that earns the piece. "We wrote a spec and it
found a bug in the thing it specified" is the concrete claim; keep the mechanism
of the bug, cut the adjectives.*

## 5. The suite has to be able to fail

A conformance suite that passes everything certifies nothing. So the suite ships
a deliberately broken verifier — plausible, written from a skim — with seven
real defects, starting with reading the verdict instead of deriving it. CI
requires both reference verifiers to pass **and** that one to fail. It fails 75
of 115 cases.

The subtle one: the broken verifier's digest is `JSON.stringify` in insertion
order, and it is perfectly self-consistent. Every integrity check it runs against
its own output passes. It fails only where the corpus pins an expected hex — the
whole reason the suite tests digests against fixed values rather than
round-tripping. An implementation can agree with itself completely and
interoperate with nobody.

And one case in the corpus exists to mark a boundary rather than test anything:
a record whose entire trust model is the word `"trustworthy"` must be
**accepted**. No suite run from outside can tell whether that paragraph is true.
Mandating the field is a forcing function on the emitter, not a proof about the
emitter, and the spec says so where an implementer will read it.

## 6. What this doesn't do

- **It is not a signature.** No keys, no author, no provenance. Anyone who can
  run the emitter can produce unlimited valid records saying anything.
- **Every measurement came from the host being attested.** An operator with root
  there does not edit a record, they rewrite the inputs and emit a fresh one.
  This format catches the lazy forgery and is transparent to the thorough one.
- **It becomes evidence when the digest leaves the writer's reach.** Post the
  record hash and the audit-chain head somewhere append-only the operator does
  not control, and a later rewrite contradicts a published digest. Until then,
  tamper-*evident* is the whole of it.
- **Zero third-party implementations.** Two reference implementations that
  agree with each other are two of ours. The metric we track is implementations
  that aren't ours; today it is zero.

## Pre-publish checklist

- [ ] `pnpm --filter @berthos/spec-attestation-record selftest` green on the
      publishing machine; paste the real numbers, don't reuse the ones above.
- [ ] §4's bug is described as *found and fixed*, with the fixing commit
      reachable — the story is worthless if a reader can't see the diff.
- [ ] The §5.2 truth table in the post matches SPEC §5.2 exactly. If the spec
      moved, the post is wrong, not stale.
- [ ] Links point at the spec on `main`, not at a branch.
- [ ] The "zero third-party implementations" line is still true.
- [ ] Decide whether to pair this with the M3.1 manifest-spec post. They are the
      two halves of one argument — what an app declares, what a run enforced —
      and either one alone invites "so what does the other half say?"
