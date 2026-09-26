# Writeup skeleton — "We wrote down what a capability declaration means, including the part that's embarrassing"

BUILD_PLAN rule 4: every M1+ task ships with a draft that could be published
as-is. This one is M3.1. Maintainer publishes; nothing below waits on an agent.

**Audience:** platform and security engineers evaluating agent sandboxes;
secondarily, anyone building an agent runtime who is about to invent their own
permission format.

**One-line thesis:** every agent runtime is growing a permission format, none of
them will tell you what enforces it, and the format is the easy half.

---

## 1. The thing everyone is quietly reinventing

Open any agent framework shipped in the last year and you find a list: allowed
tools, allowed paths, allowed domains. Different keys, same idea — say ahead of
time what the agent may touch.

What none of them say is what happens when the agent does something else.

That is not a small omission, and it isn't pedantry. "The agent can't write
outside `/workspace`" is four completely different claims depending on whether
the runtime refuses the syscall, proxies the write, logs it afterwards, or asks
the model nicely in a system prompt. All four ship. All four use the same
sentence.

## 2. So the spec makes the answer mandatory

[The Capability Manifest Specification](https://github.com/Ash20pk/BerthOS/blob/main/spec/capability-manifest/SPEC.md)
is a standalone document — its own version number, its own conformance suite,
implementable by anyone. Most of it is unremarkable grammar work:
`namespace:action:scope`, glob semantics, what a filesystem scope may be,
versioning and migration rules, error paths.

§5 is the part worth arguing about. A conforming implementation **must** publish
a machine-readable table saying, per capability, which of four words applies:

- **kernel** — the OS refuses it. A bypass is a vulnerability.
- **broker** — a process on the path refuses it. Holds while the process is
  unavoidable.
- **recorded** — nothing is prevented; it's detected and written down.
- **unenforced** — nothing stands here, by choice.

And it must not report a capability above its weakest link. An implementation
that enforces perfectly but publishes no table **does not conform**.

*Draft note: this is the section to lead with on HN. The grammar is table
stakes; the mandatory honesty is the argument.*

## 3. The rule cost us a row on our own scorecard

Berth is the reference implementation, and applying §5 to ourselves immediately
downgraded something.

`terminal:attach` writes are Landlock-gated — we'd have happily called it
kernel. But our own claims inventory marks that claim **weak**: we test that the
gate is *present*, not that pty allocation is *refused* without the grant. Under
our own rule, a claim you haven't shown denying anything isn't the stronger tier.
So the published table says **broker**, and it will move to kernel the day the
missing denial test exists, not before.

`browser:navigate` is broker forever, not by weakness but by physics: the kernel
sees ports, not hostnames. Host authorization is a proxy's job, and a proxy the
app could route around wouldn't even be broker.

*Draft note: keep this section. A spec whose first act is to demote its author's
own claim is the credibility that the rest of the argument spends.*

## 4. The suite has to be able to fail

A conformance suite that passes everything certifies nothing. So the suite ships
with a deliberately broken adapter — a plausible implementation written from a
skim of the spec — carrying five real defects: `filesystem:write:/` accepted,
globs compiled without escaping so `a.com` matches `axcom`, preview URLs on by
default, errors without a path. CI requires the reference adapter to pass **and**
that one to fail. It fails 47 of 87 cases.

The fifth defect is the interesting one: it reports its proxy as kernel tier, and
**the suite doesn't catch it**. It can't. No suite run from outside can tell
whether a tier claim is true — only that it exists, uses one of the four words,
and matches the implementation's own answers. Which is why the spec says passing
is necessary and not sufficient, and why a tier table is only worth anything next
to denial tests with controls.

*Draft note: resist the temptation to fix defect 4 to make the number prettier.
The uncatchable defect is the honest boundary of what conformance means.*

## 5. What this doesn't do

- It doesn't make anyone's enforcement better. It makes the difference legible.
- It doesn't cover authenticity — nothing signs a manifest yet.
- It has no third-party implementation. Version 1.0.0 with one implementation is
  a proposal, and the metric we track is the number of implementations that
  aren't ours; today it is zero.
- Passing the suite says nothing about whether a claimed kernel tier is real.

## Pre-publish checklist

- [ ] `pnpm --filter @berthos/spec-capability-manifest selftest` green on the
      publishing machine; paste the real numbers, don't reuse the ones above.
- [ ] Every §3 tier claim still matches `docs/internal/claims.md` — if K20 got
      its denial test since drafting, §3's example is stale and the whole point
      of §3 changes.
- [ ] Links point at the spec on `main`, not at a branch.
- [ ] The "zero third-party implementations" line is still true.
