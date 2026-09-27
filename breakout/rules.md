# The Berth break-out box

This is a live Berth sandbox. You can run any code you like inside it. Two flags are hidden in the box, and **no capability grants access to either**. Your goal is to get one out.

The box has no special hardening. It runs exactly what `berth dev` gives any app: capabilities declared in a `berth.yml`, compiled into Landlock and seccomp rules, and applied to the app's process before your code runs. If the flags stay in, that enforcement held. If you get one out, you've found a hole in Berth.

## How to play

Send an async JavaScript function body to `POST /attempt`. Your code runs in the target app's own process, with that app's privileges. `require("node:...")` returns the built-in module as a promise, so `await` it.

```bash
curl -s https://<box-host>/attempt \
  -H 'content-type: application/json' \
  -d '{"code": "const fs = await require(\"node:fs/promises\"); return await fs.readFile(\"/var/breakout/flag-kernel.txt\", \"utf-8\");"}'
```

The response is `{ ok, output, captured }`: what your code returned or threw, and which flag, if any, appeared in the output.

- The request body can be at most 16 KB.
- Each attempt has a 30-second time limit.
- Attempts run one at a time. If another is running, you get `429`; try again.

## The two flags

- **FLAG_KERNEL** is a file at `/var/breakout/flag-kernel.txt`, mode **0644**. Ordinary Unix permissions *allow* the read. The only thing stopping you is the Landlock policy compiled from the target app's `berth.yml`, which doesn't declare that path. Read it and you've beaten the kernel layer.

- **FLAG_COTENANT** is a per-app secret belonging to a *second* app in the same sandbox. It's in a `0600` file owned by that app's uid, and it's in no environment your app can see. Read it and you've beaten per-app isolation.

## Scope

**In scope:** anything your submitted code can do from inside the sandbox to reach a flag. Filesystem tricks, symlinks, `/proc`, the co-tenant's socket, namespaces, escaping the target process, or anything else you can think of.

**Out of scope:**

- Attacking the HTTP server, the host, or the network around the box. The server is a thin relay on a disposable host.
- Denial of service.
- Anything that needs credentials to the host.
- `docker exec` or any other access as root on the host. Root on the host bypasses the sandbox by design. You are the workload, not the host.

## If you capture a flag

Your winning submission is already in the public attempt log (`GET /log`). Open an issue on the Berth repository linking its sha256, or report it privately as described in SECURITY.md in the repository.

The reward is recognition and a fix. This is a demonstration, not a bounty program. The result becomes public either way.

## Checking our side

- `GET /attestation` shows the enforcement measured live when the box booted: the `berth doctor` probe and the Landlock status each app reported. If it doesn't say the kernel was enforcing, the kernel flag isn't protected, and you should tell us.
- `GET /log` lists every attempt, hash-chained. It's tamper-evident, not tamper-proof: we could rewrite it, but not without contradicting the copies you've already fetched.
