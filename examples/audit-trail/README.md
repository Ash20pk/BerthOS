# `audit-trail`

Berth's audit trail is hash-chained JSONL: each record commits to the one before it, so anyone can recompute the chain without trusting the process that wrote it. This demo shows what that catches and what it doesn't. It needs no Docker, no kernel features and no API key.

## Run it

```bash
pnpm install && pnpm build      # once, from the repo root
cd examples/audit-trail
pnpm start                      # or: node index.mjs
```

## Expected output (abridged)

```
--- clean chain ---
verification: VALID

--- tampering ---
attacker edits record 1: decision "denied" -> "allowed", drops the reason
verification: BROKEN at record 1

after replaying the edited events through a fresh sink: VALID again
```

A single edited record breaks the chain at exactly that record. But anyone who can write the file can also rewrite the whole chain, and a full rewrite verifies again. So the trail is tamper-evident, not tamper-proof. To make it tamper-proof, store the latest hash somewhere an attacker can't rewrite, such as a WORM log or a notary. You only need to pin the latest hash, not every record.

The audit format and API are in the [audit reference](../../docs/audit-reference.md).
