# `audit-trail`

The third leg of IAM after declare and enforce: *prove*. Berth's audit trail is
hash-chained JSONL — each record commits to the one before it — so a third party
can recompute the whole chain without trusting the process that wrote it. This
demo needs no Docker and no kernel; it's about the record itself.

```
--- clean chain ---      verification: VALID
--- tampering ---        attacker edits record 1: "denied" -> "allowed"
                         verification: BROKEN at record 1
--- the honest part ---  after replaying the edited events through a fresh sink: VALID again
```

It catches a single-record edit at the exact record — and then does the part
most audit-log pitches skip: it rewrites the chain *properly* and shows it
verifies again, because anyone who can write the file can recompute it.
Tamper-**evident**, not tamper-**proof**. For tamper-proof you pin the latest
hash somewhere the attacker can't reach (a WORM log, a notary); the chain is
what makes that cheap. Run with `node index.mjs` (or `pnpm start`).
