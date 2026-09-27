# The Berth break-out box

A public Berth sandbox that runs any code a stranger sends and dares them to read a flag no capability grants. It runs exactly what `berth dev` gives any app, with no extra hardening: capabilities from a `berth.yml`, compiled into Landlock and seccomp rules, applied before the stranger's code runs. A flag that stays in is Berth's normal enforcement holding. A flag that gets out is a hole in Berth.

Challengers read [rules.md](./rules.md), which the server also serves at `GET /`.

## Run it

Use a **disposable** Linux host that holds nothing else, with a kernel that enforces Landlock. You are handing strangers code execution on it.

```bash
BREAKOUT_BIND=0.0.0.0 ./breakout/deploy.sh
```

`deploy.sh` runs `berth doctor`, installs, builds and starts the server. The server **refuses to start** if the host can't enforce Landlock. The default bind is loopback; for a public box, put a TLS-terminating proxy in front.

| Env var | Default | Meaning |
|---|---|---|
| `BREAKOUT_BIND` | `127.0.0.1` | Address to listen on. |
| `BREAKOUT_PORT` | `8099` | Port to listen on. |
| `BREAKOUT_MAX_CODE_BYTES` | `16384` | Largest accepted request body. |
| `BREAKOUT_ATTEMPT_TIMEOUT_MS` | `30000` | Time limit per attempt. |
| `BREAKOUT_ALLOW_UNENFORCED` | unset | `1` serves on a host that can't enforce, for a deliberately unprotected demo. |

## The two flags

| Flag | Where | Guarded by |
|---|---|---|
| `FLAG_KERNEL` | `/var/breakout/flag-kernel.txt`, mode 0644 | Landlock alone. File permissions allow the read. |
| `FLAG_COTENANT` | A second app's per-app secret, a 0600 file owned by its uid | The per-app uid split. |

## Endpoints

| Endpoint | What it does |
|---|---|
| `GET /` | The rules (`rules.md`). |
| `POST /attempt` `{"code":"…"}` | Runs an async JS function body in the target app's process. Returns `{ ok, output, captured }`, where `captured` lists any flag found in the output. One attempt at a time; a second concurrent one gets `429`. |
| `GET /attestation` | The enforcement measured at boot (doctor probe, each app's Landlock status, boot ID, image digest). |
| `GET /log` | Every attempt, hash-chained with `@berthos/audit`, plus whether the chain is intact and its head. |

## Files

| File | What |
|---|---|
| `box.mjs` | Boots the sandbox and runs attempts. Shared by the server and the test, so the two can't drift apart. |
| `server.mjs` | The HTTP server: one attempt at a time, every attempt logged, refuses to serve unenforced. |
| `deploy.sh` | Preflight, install, build, serve. |
| `apps/breakout-target/` | The target app that runs submitted code, with ordinary capabilities. |
| `apps/flag-keeper/` | The co-tenant app holding `FLAG_COTENANT`. |
| `test/breakout-milestone.mjs` | Checks that an enforced boot refuses every flag read, and that a boot with the kernel layer off leaks the flag. |
| `rules.md` | The public rules and scope. |

## Limits

- **`docker exec` is out of scope.** Root on the host bypasses the sandbox (see the [threat model](../docs/threat-model.md)). The box tests what the workload can reach, not the host.
- **The server isn't a boundary.** It's a thin relay on a disposable host; attacking it proves nothing about Berth.
- **The log is tamper-evident, not tamper-proof.** The host could rewrite it, but not without contradicting copies challengers already fetched.
