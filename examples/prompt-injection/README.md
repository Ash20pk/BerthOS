# `prompt-injection`

The demo that assumes the model already lost. [`index.mjs`](./index.mjs) uses a scripted, compromised model that reads a poisoned document and does exactly what its hidden instruction says: write a cron backdoor to `/etc`. The agent loop is the real one from `@berthos/agents`, and the app is the real [`apps/filesystem`](../../apps/filesystem), scoped to `filesystem:write:/workspace` only.

## Run it

Needs Docker and a kernel with Landlock (check with [`berth doctor`](../../docs/doctor-reference.md)). No API key: a real jailbroken model would make the same `write_file` call.

```bash
pnpm install && pnpm build      # once, from the repo root
cd examples/prompt-injection
pnpm start
```

## Expected output

```
the model obeyed the injection and called: write_file("../../../etc/berth-persist-pwned", ...) -> resolves to /etc/berth-persist-pwned
the kernel's answer: EACCES: permission denied, open '/etc/berth-persist-pwned'

audit trail: 5 hash-chained records at <temp dir>/audit.jsonl
chain verification: VALID
the refusal is on the record: tool:write_file failed — "EACCES: permission denied, open '/etc/berth-persist-pwned'"

PASS — the model was fully compromised and complied. The write to /etc died in the kernel.
```

The app never checks the path. The Landlock ruleset compiled from `berth.yml` refuses it before the app's code sees it. Every step, including the refusal, is written to a hash-chained audit trail that anyone can verify. The `runId` the script passes to `agent.run()` is the one you'd give `berth attest <runId>` to produce an attestation record for the run.

On a machine that can't enforce, the demo refuses to boot. `BERTH_ALLOW_UNENFORCED=1` boots it anyway; it then reports `NOT ENFORCED` and exits 1. See the [examples README](../README.md) for setting up an enforcing host.
