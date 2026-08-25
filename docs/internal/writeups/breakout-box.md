# Writeup skeleton — "Here is a sandbox running our code. Try to break it."

Status: skeleton (BUILD_PLAN rule 4 — the maintainer deploys and publishes;
every claim already has its artifact). Companion artifacts:
[breakout/README.md](../../../breakout/README.md),
`breakout/test/breakout-milestone.mjs`, `breakout/rules.md`,
[verification record](../verification/breakout-box-2026-08-23.md).

## The hook

We put a Berth sandbox on the public internet, gave everyone code execution
inside it, and hid two flags that no capability grants. No special hardening —
the box runs exactly what `berth dev` gives any app. If the flags stay in, the
enforcement held against real strangers. If one comes out, someone found a hole
in Berth, and it is already in the public log.

## The shape of the piece

1. **Why a break-out box and not another benchmark.** The containment
   benchmark (M2.2) is us running our own attacks. This is everyone else
   running theirs, continuously, against the same code. The benchmark says
   "here is what we tested"; the box says "here is what nobody has gotten past
   yet, and here is the log so you can check."

2. **The 0644 flag — the whole idea in one file mode.** `flag-kernel.txt` is
   world-readable. Ordinary Unix permissions *allow* the read. The only thing
   between a submission and the flag is the Landlock domain compiled from the
   target app's `berth.yml`, which never named that path. Show the attempt and
   the `EACCES` it comes back with. This is the cleanest possible statement of
   what the kernel tier does.

3. **The negative control, shipped in the test.** The milestone boots the box
   a second time with enforcement off and proves the same submission reads the
   flag. So when the enforced box refuses, that is Landlock, not luck. Show
   both.

4. **The bug the box found in us, before any stranger did.** Building the
   co-tenant flag surfaced a real defect: per-app secret scoping was decided
   only by whether the name *looked* like a credential, so a declared secret
   with an ordinary name silently went to plaintext and reached every app.
   Fixed in the same branch, with a regression test. This is the section that
   earns trust — the box works on us too, and we are telling you about the
   miss.

5. **Checking our side.** `/attestation` publishes which enforcement was
   *measured* live at boot (M2.1), and it is the first time a Berth chain head
   leaves our reach: once you have fetched it, we cannot rewrite the box's log
   without contradicting your copy. `/log` is the hash-chained record of every
   attempt. Tamper-evident, not tamper-proof — and we say which.

6. **The edges, named up front.** `docker exec` is out of scope: root on the
   host bypasses the sandbox by construction, and pretending otherwise would be
   the dishonest version of this. The server is a disposable relay; attacking
   it proves nothing.

## Demo material

- The one-liner `curl` that reads the flag and gets `EACCES`, next to the same
  command against a plain Docker container that gets the flag.
- A link to the live `/log` with a few real denied attempts in it.
- Pre-publish checklist: deploy on a fresh disposable VM; confirm
  `/attestation` says `enforcing` before announcing the URL; keep nothing else
  of value on the host.
