# Verification record — public break-out box (BUILD_PLAN M2.3)

Date: 2026-08-23. Branch `m2/breakout-box`. Host: Colima enforcing daemon
(`DOCKER_HOST=unix://~/.colima/default/docker.sock`, kernel 6.8.0-117-generic,
Ubuntu 24.04.4, arm64).

## Milestone test

`node breakout/test/breakout-milestone.mjs` — all 8 checks PASS. Measured
enforcement for the box's boot: doctor probe `enforcing`; agent-init reported
`FullyEnforced` for `breakout-target`, `flag-keeper`, and `context-bus-daemon`.

Enforced boot (the box exactly as the public endpoint runs it):
1. a submission uses its own scratch directory — positive control ✅
2. reading `/var/breakout/flag-kernel.txt` (mode 0644) refused by the policy ✅
3. the same read via a planted symlink refused ✅
4. the co-tenant's per-app secret file unreadable ✅
5. listing `/run/berth` to find it refused ✅
6. outbound TCP refused ✅
7. neither flag present in the target app's own environment ✅

Negative control (kernel tier switched off with `BERTH_DISABLE_FS_SIDECAR=1` +
the landlock-ENOSYS seccomp profile):
8. the same submission reads the kernel flag — it leaks ✅

Assertion 8 is why 2 is a claim about Landlock and not about a file mode: the
flag is 0644, so DAC permits the read, and the flag only stays in when the
compiled Landlock domain refuses it.

## Live server smoke test

`breakout/server.mjs` booted in-process, exercised over HTTP:
- `POST /attempt` reading the kernel flag → `{"ok":false}` with
  `EACCES: permission denied, open '/var/breakout/flag-kernel.txt'`.
- `POST /attempt` writing the app's own scratch dir → `{"ok":true}`.
- `GET /attestation` → `kind: berth.breakout-box-boot`, enforcement
  `enforcing`.
- `GET /log` → 2 records, `chainIntact: true`, both decisions `denied`.

## A real defect this task found (fixed in-branch)

Per-app secret scoping was gated **only** by a name-shape heuristic
(`isSecretEnvName`: `*_TOKEN`, `*_KEY`, fragments like `SECRET`/`PASSWORD`).
A secret declared under `secrets:` in a manifest whose name did not match —
`BREAKOUT_FLAG_COTENANT` — was routed to Docker's plaintext `Env` and reached
**every** app in the container, while the operator was warned "no value was
provided for this boot." An explicit manifest declaration now outranks the
heuristic (`partitionSecretEnv(env, declaredNames)`). Regression test:
`secrets.test.ts` "a name declared under secrets: is secret even when it looks
nothing like a credential." This is the M1.3 posture being made to match its
own documentation; found because the box's co-tenant flag leaked in check 7
before the fix.

## Caveats, stated

- **`docker exec` is out of scope, by construction.** Root on the host reaches
  everything; the box tests the workload's reach, not the host's. The rules
  doc and threat model both say so.
- **The server is a thin relay, not a boundary.** Attacking it, the host, or
  the surrounding network is out of scope; every protection that matters is
  inside the sandbox.
- **The host must enforce Landlock or the server refuses to start**
  (`BREAKOUT_ALLOW_UNENFORCED=1` overrides, for an intentionally unprotected
  demo). On a non-enforcing host the kernel flag is not protected, and both the
  server and the milestone test say so rather than going quietly green.
- **Not yet hosted.** The deploy script and recipe are written and locally
  exercised; a maintainer runs it on a disposable VM and publishes the URL.
  The published boot attestation is the first Berth chain head to leave the
  writer's reach (M2.1's trust-model upgrade), but only once it is actually
  public.
