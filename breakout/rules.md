# The Berth break-out box

This is a live Berth sandbox. You can run any code you like inside it. Hidden
in the box are two flags that **no capability grants** — the challenge is to
get one out.

There is no special hardening here. The box runs exactly what `berth dev` gives
any app: capabilities declared in a `berth.yml`, compiled into a Landlock
domain and a seccomp filter, applied to the app's process before your code
runs. If the flags stay in, it is because that enforcement held. If you get one
out, you have found a hole in Berth itself.

## How to play

Submit an async JavaScript function body. `require("node:...")` returns the
built-in module (as a promise — `await` it). Your code runs in the target app's
own process, with the target app's own privileges.

```bash
curl -s https://<box-host>/attempt \
  -H 'content-type: application/json' \
  -d '{"code": "const fs = await require(\"node:fs/promises\"); return await fs.readFile(\"/var/breakout/flag-kernel.txt\", \"utf-8\");"}'
```

The response tells you what your code returned or threw, and — if your output
contained a live flag — which one you captured.

## The two flags

- **FLAG_KERNEL** — a file at `/var/breakout/flag-kernel.txt`, mode **0644**.
  Ordinary Unix permissions *allow* the read. The only thing between you and it
  is the Landlock policy compiled from the target app's `berth.yml`, which
  never declared that path. Read it and you have beaten the kernel tier.

- **FLAG_COTENANT** — delivered to a *second* app sharing this sandbox, as a
  per-app secret. It lives in a `0600` file owned by that app's uid, and it is
  in no environment your app can see. Reach it and you have beaten the per-app
  isolation.

## Scope and reward

- In scope: anything your submitted code can do from inside the sandbox to
  reach a flag — filesystem tricks, symlinks, `/proc`, the co-tenant's socket,
  namespace games, escaping the target process, whatever you can think of.
- Out of scope: attacking the HTTP server, the host, or the network around the
  box (it is a thin relay and is expected to be disposable); denial of service;
  anything that needs credentials to the host. Those are not what this proves.
- The `docker exec` path is explicitly out of scope: the box's own threat model
  says root on the host bypasses the sandbox by construction. You are the
  workload, not the host.

Reward: recognition and a fix. If you capture a flag, the submission that did
it is already in the public attempt log (`GET /log`) — open an issue linking
its sha256, or use the disclosure path in SECURITY.md for anything you would
rather report privately. This is a demonstration, not a bounty program; the
honest result, either way, becomes public.

## Checking our side of it

- `GET /attestation` — the box's boot attestation: which kernel enforcement was
  *measured* live at boot, not asserted. If it does not say the kernel was
  enforcing, the box is not holding the kernel flag and you should say so.
- `GET /log` — every attempt, hash-chained. Tamper-evident, not tamper-proof
  (see docs/audit-reference.md): we could rewrite it, but not without
  contradicting the copies you already fetched.
