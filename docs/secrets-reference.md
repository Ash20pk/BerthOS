# Secrets reference

How API keys and other credentials reach a sandbox, and who can read them. Berth keeps credentials out of the container's configuration, so they don't show up in `docker inspect` or in snapshots, and a secret an app declares reaches only that app.

## Use it

Declare the environment variables an app needs in its `berth.yml`. Names only, never values:

```yaml
# berth.yml
name: github-assistant
secrets:
  - GITHUB_TOKEN
```

Pass the values in the `env` you boot the sandbox with: the `env` option of `startContainer()` from `@berthos/docker-orchestrator`, or `Computer.boot({ apps, env })` in the experimental agent framework. For example `env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN }`. Inside the app, read it as usual: `process.env.GITHUB_TOKEN`.

- A declared name reaches only the apps that declared it. Two apps may declare the same name, and each gets it.
- A declared name with no value at boot prints a warning naming it (never the value), and the app boots without it.
- A `secrets:` entry must be a valid environment variable name.

## How it works

Docker's container environment (`Env`) is permanent: anyone who can inspect the container sees it, and it is copied into every `docker commit` and snapshot. So Berth splits the environment it's given before creating the container:

| | Where it goes | In `docker inspect` | In a commit or snapshot |
|---|---|---|---|
| Ordinary variables (`BERTH_APPS`, `BERTH_WORKSPACE_ROOT`, ...) | Docker `Env` | yes | yes |
| Credentials no app declared (`ANTHROPIC_API_KEY`, `BERTH_HTTP_RPC_TOKEN`, `BERTH_TERMINAL_CREDENTIAL`, `BERTH_VNC_PASSWORD`, ...) | a shared file, mounted read-only at `/run/berth/secrets.env` | no, only the mount path | no |
| Names an app declared under `secrets:` | a file per app, delivered as `/run/berth/secrets.<app>.env`, mode 0600, owned by that app's uid | no | no |

The sandbox's entrypoint loads the shared file before anything starts, so every process sees those values. It loads each per-app file only in that app's own process tree, so other apps can't read it from their environment, from `/proc/<pid>/environ`, or from the file.

On the host, the files live in `~/.berth/run/<container name>/` (files 0600, directory 0700) and are deleted when the container stops. A container with no credentials gets no files and no mount.

If a secrets file is set but can't be read at boot, the sandbox refuses to start rather than running the app without its credentials.

### Which names count as credentials

A name you declare under `secrets:` is always treated as a credential. Any other name is treated as one if it contains (case-insensitive) `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `API_KEY`, `APIKEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `SESSION_KEY` or `AUTH`, or ends in `_KEY` or `_PAT`. So `AZURE_OPENAI_KEY` is a credential and `BERTH_MESH_KEY_PATH` is not. The rules are in `isSecretEnvName()` in `packages/docker-orchestrator/src/secrets.ts`.

If a credential's name matches none of these, declare it under `secrets:` or rename it (anything ending in `_TOKEN` or `_KEY` works). Otherwise it goes into `Env` in plain text.

## Snapshots

`berth snapshot create` saves the container's environment to `env.json`, minus any credential-named values, and records the names it left out. `berth snapshot restore` tells you which ones to supply again:

```
Warning: this snapshot deliberately did not capture 1 credential-valued environment variable(s): ANTHROPIC_API_KEY. The restored sandbox boots without them — set them in the environment of whatever drives it (see docs/secrets-reference.md).
```

Snapshots are stored in `~/.berth/snapshots/<app>/<id>/` (directory 0700, `env.json` 0600).

## Files on the host

| File | Holds | Mode |
|---|---|---|
| `~/.berth/run/<container>/` | this boot's credentials | files 0600 in a 0700 directory, deleted on stop |
| `~/.berth/os/<name>.json` | the bearer token for `berth os up --http-rpc` | 0600 in a 0700 directory |
| `~/.berth/snapshots/<app>/<id>/` | snapshot image, context data, `env.json` | 0700 directory, `env.json` 0600 |
| `~/.berthrc` | fleet aliases and their `env`, usually provider keys for remote deploys | you set it. `berth` warns if an alias carries `env` and the file isn't 0600: `chmod 600 ~/.berthrc` |

## What this does not protect against

- **Anyone who can reach the Docker socket.** They can `docker exec` into the container as root, or read the host files directly. Docker socket access is root on the host.
- **Undeclared secrets inside the container.** A credential no app declares under `secrets:` goes into the shared file, which every app in the container can read. Declare it to scope it to one app. Berth's own daemons, which start before any app, can read everything.
- **Encryption at rest.** The files are plain text protected by file modes. A host backup, a stolen disk or root can read them.
- **Remote fleets.** `berth deploy --fleet=...` hands `env` to the provider (E2B, Daytona, or a Kubernetes Pod spec). There it is stored on the provider's terms; on Kubernetes, `kubectl get pod -o yaml` shows it. Berth doesn't create Kubernetes `Secret` objects.
- **Rotation.** Credentials are delivered at boot. Changing one means restarting the container.
