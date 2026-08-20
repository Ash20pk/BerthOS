# Secrets reference

What Berth does with a credential you hand it, where each one is written, and — the part that matters for deciding whether to trust this — what it deliberately does not protect.

Closes *5.5* in [REMEDIATION.md](./internal/REMEDIATION.md). Before it, a booted sandbox's provider API key and RPC bearer token were permanently readable from `docker inspect`, `~/.berthrc` and `~/.berth/os/<name>.json` were written at the umask's 0644, and `berth snapshot create` copied the whole container environment into a `env.json` that any snapshot copied to another machine carried with it — under a comment claiming snapshots captured no secrets.

## The one rule

**A credential never becomes container configuration.**

Docker's `Env` on `createContainer` is permanent, immutable metadata. A value put there is readable by anything that can reach the Docker socket for the container's whole life, is copied verbatim into every `docker commit` of it, appears in every fresh `docker exec` process, and is what `berth snapshot create` reads back out to build a snapshot. There is no way to remove it from a running container and no way to redact it after the fact.

So credentials travel a different road. `startContainer()` splits the environment it was given by name:

| | Where it goes | Visible in `docker inspect` | In a `commit` / snapshot |
|---|---|---|---|
| `BERTH_APPS`, `BERTH_HTTP_RPC_PORT`, `BERTH_WORKSPACE_ROOT`, … | Docker `Env` | yes | yes |
| `ANTHROPIC_API_KEY`, `BERTH_HTTP_RPC_TOKEN`, `BERTH_TERMINAL_CREDENTIAL`, `BERTH_VNC_PASSWORD`, … | a 0600 host file, bind-mounted read-only at `/run/berth/secrets.env` | **no** — only the mount path | **no** — `commit` excludes mount points |

`docker/entrypoint.sh` sources that file (`set -a`) before any daemon or app starts, so every process in the container inherits these exactly as if they had been passed as `Env` all along. Nothing in an app changes; `process.env.ANTHROPIC_API_KEY` is there either way.

The file lives at `~/.berth/run/<container name>/secrets.env`, 0600 inside a 0700 directory, and `stopContainer()` deletes the directory. A container whose environment holds no credentials gets no mount and no file — it is byte-for-byte what it was before this existed.

### What decides that a name is a credential

`isSecretEnvName()` in `packages/docker-orchestrator/src/secrets.ts`. Case-insensitive substring match on `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `API_KEY`, `APIKEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `SESSION_KEY`, `AUTH`, plus a `_KEY` / `_PAT` suffix rule for the names a substring can't catch safely (`AZURE_OPENAI_KEY` is a key; `BERTH_MESH_KEY_PATH` is a path).

Deliberately broad and deliberately dumb, because the costs are not symmetric. A false positive means a non-secret value travels through a file instead of through `Env`, which nothing can observe. A false negative means a credential in `docker inspect` forever.

If you have a credential in a variable this misses, **rename it** — anything ending `_TOKEN` or `_KEY` works — or add it to `EXPLICIT_SECRET_NAMES`, which exists precisely so that the alternative (broadening a fragment until it catches one name and a hundred others) doesn't happen.

### Fails closed

If `BERTH_SECRETS_FILE` is set and the file is unreadable, `entrypoint.sh` prints what is missing and exits 1 rather than booting an app without the credential it asked for. A sandbox that boots and then 401s against a model provider is much harder to diagnose from inside the container than a refusal is from outside it.

## Snapshots

`createSnapshot()` strips credential-valued entries from `env.json`, writes it 0600 in a 0700 snapshot directory, and records the withheld *names* in `metadata.redactedEnvNames`. `berth snapshot restore` prints them:

```
Warning: this snapshot deliberately did not capture 1 credential-valued environment variable(s):
ANTHROPIC_API_KEY. The restored sandbox boots without them.
```

The names are kept because "this snapshot contains no secrets" is only a useful guarantee if what it cost you is visible. `BERTH_SECRETS_FILE` is dropped silently and separately — it points at a mount that exists only for the boot that made it, and replaying it into a restore on another machine would hit the fail-closed path above.

This is belt and braces: because `berth snapshot create` builds its `env` by reading the running container's `Config.Env` back out of `docker inspect`, the split above already keeps credentials out of a snapshot. The strip runs anyway, for a caller that assembles `env` by hand or snapshots a container something else started.

## Files on the host

| File | Holds | Mode |
|---|---|---|
| `~/.berth/run/<container>/secrets.env` | this boot's container credentials | 0600 in a 0700 dir, deleted on stop |
| `~/.berth/os/<name>.json` | `berth os up --http-rpc`'s bearer token | 0600 in a 0700 dir |
| `~/.berth/snapshots/<app>/<id>/` | committed image, context-data, `env.json` | 0700 dir, `env.json` 0600 |
| `<grants data dir>/operator.token` | grants-server operator token | 0600 (unchanged — this one was always right) |
| `~/.berthrc` | fleet alias adapters **and their `env`**, i.e. provider keys for remote deploys | **yours to set.** `berth` warns, once, when a credential-carrying one is group- or world-readable |

Berth chmods files it creates. It does not chmod `~/.berthrc`: that is the developer's own file, silently rewriting its mode is a surprise in the other direction, and refusing to read it would break every existing `--fleet` invocation on upgrade. The warning names the fix (`chmod 600 ~/.berthrc`) and only fires when an alias actually carries `env`.

Modes are set with an explicit `chmod` after the write, not with `writeFile`'s `mode` option alone — that option is masked by the umask on creation and **ignored entirely for a file that already exists**, and every one of these files already exists on the second run.

## What this does not protect against

Stated plainly, because a partial protection sold as a complete one is worse than none.

- **Anyone who can reach the Docker socket.** They can `docker exec` into the container, read `/run/berth/secrets.env` as root, or read the host file directly — the bind mount's host path is right there in `docker inspect`. Docker socket access is root-equivalent on the host; this change does not pretend otherwise. What it closes is the far weaker requirement of *merely being able to inspect metadata*, or of receiving a snapshot someone else made.
- **Anything running inside the container — with one boundary that is now real.** A secret an app declares under `secrets:` in `berth.yml` is delivered only to that app: it leaves the shared file, arrives as `/run/berth/secrets.<app>.env` (0600, owned by that app's uid), and is sourced only in that app's own process tree — a sibling cannot read it by env, by `/proc/<pid>/environ` (per-app uids; container root itself lacks `CAP_SYS_PTRACE`), or by the file's DAC. What per-app scoping does **not** cover: an *undeclared* secret still travels through the shared file to every app (backward compatibility is explicit — declare it to scope it); the pre-`agent-init` root daemons can still read anything (threat model B4, M1.2's territory); and root — `docker exec` — reads every file regardless.
- **Encryption at rest.** Nothing here is encrypted (*5.4*). These are plaintext files protected by file modes; a host backup, a stolen disk, or root reads them.
- **Remote fleets.** `berth deploy --fleet=…` passes `env` to the provider's own API (E2B, Daytona, a Kubernetes Pod spec). Those values live in that provider's control plane, on their terms — a K8s deployment puts them in the Pod spec, where `kubectl get pod -o yaml` shows them. Berth does not create Kubernetes `Secret` objects. The `~/.berthrc` warning is about the local copy; the remote copy is the provider's exposure surface, not one Berth can close.
- **The audit log and logs generally.** Berth's audit records don't capture env, and payload capture is off by default (*5.1*) — but an app that prints its own key to stdout puts it in `docker logs`, and nothing intercepts that.
- **`git`, your shell history, and your CI provider.** A key exported in a shell, committed to a repo, or pasted into a CI variable is outside Berth entirely.

## What is verified, and how

- `secrets-milestone.mjs` — a real container, and the assertion that matters in both directions: `docker inspect` carries neither the RPC token nor the API key under any name, the host file is 0600 in a 0700 dir, **and** the HTTP RPC bridge authenticates the bearer token it was never given in `Env` (a token that is merely never delivered would pass the absence checks and fail this one). Plus: `docker exec env` sees neither value, a real `createSnapshot()` of that container writes an `env.json` with neither value at 0600 and names what it withheld, the committed `image.tar` contains neither byte-string, and stopping the container removes the host file.
- `published-port-security-milestone.mjs` — the same mechanism for two non-Node consumers started by `entrypoint.sh` rather than by the SDK: `BERTH_TERMINAL_CREDENTIAL` is absent from `Env`, and ttyd still refuses an unauthenticated request, refuses a wrong credential, and accepts the generated one. Same for x11vnc, asserted at the RFB protocol level. This file used to assert the exact opposite — that the password *was* in the container's `Env`.
- Unit tests — the classifier against Berth's own names and real provider names in both directions; the serializer round-tripped through a real `bash` with values containing `$(…)`, backticks, single quotes and newlines (getting this wrong would make the shell *execute* part of a credential at boot); modes re-tightened on a file that already exists; `~/.berthrc`'s warning firing for a loose credential-carrying config, staying quiet for a 0600 one and for a loose one with no `env`, and never printing the credential it warns about.

### Declaring per-app secrets

```yaml
# berth.yml
name: github-assistant
secrets:
  - GITHUB_TOKEN        # names, never values — values come from the boot environment
```

A name declared by any app in the container leaves the shared file entirely and is delivered only to the apps that declared it. Two apps may declare the same name and each receives it. A declared name with no value at boot is warned about by name (never by value) and the app boots without it. A container in which no app declares `secrets:` boots byte-for-byte as it did before this existed.

Verified by `per-app-secrets-milestone.mjs`: a two-app boot where app A declares a token — absent from `docker inspect`, absent from the shared file, present in A's process environment and absent from B's (each read as its own uid), unreadable by B through `/proc/<pidA>/environ` and through the 0600 file, readable by A (the positive control) — followed by a control boot with no declaration in which the token reaches both apps, proving the isolation assertions can fail.

## Still open

- No secret store integration. There is a seam (`secrets.ts` is the one place that decides what a secret is and where it goes) and no Vault/KMS/1Password backend behind it. Values still come from the caller's own environment.
- No rotation. A credential is delivered at boot; changing it means restarting the container.
- ~~No per-app scoping~~ **Per-app scoping shipped** (BUILD_PLAN M1.3): `secrets:` in `berth.yml` names the env vars an app needs; declared names are delivered only to declaring apps. Verified by `per-app-secrets-milestone.mjs` (see below). Undeclared secrets keep the shared-file behavior deliberately.
- Nothing encrypted at rest (*5.4*), and no identity model to scope a secret to (*5.2*).
