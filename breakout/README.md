# The Berth break-out box

A standing Berth sandbox that hands strangers code execution and dares them to
reach a flag no capability grants. BUILD_PLAN M2.3.

The point is not the box — it is what the box proves. It runs **exactly what
`berth dev` gives any app**: capabilities from a `berth.yml`, compiled into a
Landlock domain and a seccomp filter, applied to the app's process before the
stranger's code runs. There is no hardening added for the challenge. A flag
that stays in is the shipped enforcement holding; a flag that comes out is a
hole in Berth.

## The two flags

| Flag | Where | Guarded by |
|---|---|---|
| `FLAG_KERNEL` | `/var/breakout/flag-kernel.txt`, mode **0644** | Landlock alone — DAC permits the read, so only the compiled policy refuses it |
| `FLAG_COTENANT` | a co-tenant app's per-app secret (0600, its uid) | the per-app uid split (M1.3) |

## Run it

The box is only honest on a host whose kernel enforces Landlock, and it should
run on a **disposable** host holding nothing else — the premise is giving
strangers code execution on it.

```bash
BREAKOUT_BIND=0.0.0.0 ./breakout/deploy.sh
```

The server **refuses to start** on a host that cannot enforce, rather than
advertise a boundary that is not there (`BREAKOUT_ALLOW_UNENFORCED=1` overrides,
for a deliberately unprotected demo). Put a TLS-terminating proxy in front for a
public deployment; the default bind is loopback.

## Endpoints

- `GET /` — the rules (`rules.md`).
- `POST /attempt` `{"code":"…"}` — run an async JS function body in the target
  app's own process; `require("node:…")` returns the built-in (await it). The
  response says what you returned or threw, and which flag (if any) your output
  contained.
- `GET /attestation` — the box's boot attestation (M2.1): the enforcement
  *measured* live at boot, not asserted.
- `GET /log` — every attempt, hash-chained (`@berth/audit`). Tamper-evident,
  not tamper-proof.

## Files

| File | What |
|---|---|
| `box.mjs` | Boots the sandbox and runs attempts. **Shared by the server and the test**, so the public endpoint and the proof cannot diverge. |
| `server.mjs` | The HTTP relay: rate-limited to one attempt at a time, audited, refuses to serve unenforced. |
| `deploy.sh` | One-command deploy: preflight, install, build, serve. |
| `apps/breakout-target/` | The target app — runs stranger code, ordinary capabilities. |
| `apps/flag-keeper/` | The co-tenant holding `FLAG_COTENANT`. |
| `test/breakout-milestone.mjs` | The verification artifact: the enforced boot's refusals **and** a weakened-boot negative control proving the flag leaks when enforcement is off. |
| `rules.md` | The public challenge rules and scope. |

## What this does not prove

- **`docker exec` is out of scope.** Root on the host bypasses the sandbox by
  construction (see [docs/threat-model.md](../docs/threat-model.md)); the box
  tests the workload's reach, not the host's.
- **The server is not a boundary.** It is a thin relay on a disposable host;
  attacking it, the host, or the surrounding network proves nothing about
  Berth.
- **Off an enforcing kernel, the kernel flag is not protected** — which is why
  the server refuses to serve there, and both it and the test say so plainly.
