# `prompt-injection`

The demo that assumes the model already lost. There is no jailbreak to attempt
here — [`index.mjs`](./index.mjs) hard-codes a compromised `LLMProvider` that
reads a poisoned document and does exactly what the hidden instruction says:
write a cron backdoor to `/etc`. The agent loop is the real one from
`@berth/agents`; the app is the real `apps/filesystem`, scoped to
`filesystem:write:/workspace` and nothing else.

```
the model obeyed the injection and called: write_file("../../../etc/berth-persist-pwned", ...) -> resolves to /etc/berth-persist-pwned
the kernel's answer: EACCES: permission denied, open '/etc/berth-persist-pwned'

audit trail: 5 hash-chained records
chain verification: VALID
the refusal is on the record: tool:write_file failed — "EACCES: permission denied, open '/etc/berth-persist-pwned'"

PASS — the model was fully compromised and complied. The write to /etc died in the kernel.
```

Nothing in the app validated that path — the Landlock ruleset compiled from
`berth.yml` did, before the app's first line ran. Every step, including the
refusal, is in a hash-chained audit trail a third party can verify. The `runId`
this passes to `agent.run()` is also what you'd hand `berth attest <runId>` to
emit a per-run attestation record.

No API key: a real jailbroken model reaches the same `write_file` call. Needs a
kernel with Landlock — run [`berth doctor`](../../docs/doctor-reference.md). See
the top-level [examples README](../README.md) for the enforcing-host setup.
