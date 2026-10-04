# Snapshots

`berth snapshot` saves a running sandbox and brings it back later as a fresh container: its filesystem and installed packages, plus everything in [`/context`](./semantic-fs-reference.md) and its tag index. Use it to checkpoint an agent's work before a risky step, or to start several runs from the same state. On E2B and Daytona the same commands use the provider's own pause, snapshot and fork.

## Context

You take and restore snapshots with the `berth` CLI, from the app's directory. Locally the sandbox is a Docker container started by `berth dev`; on a remote fleet, the snapshot is the provider's.

## Containers

Locally, the CLI works against Docker: it commits the running container, archives the files behind `/context` and its tag index, and writes the snapshot to a directory on the host. `restore` loads the image back into Docker and starts a new container alongside the original. With `--fleet`, the CLI calls the provider instead (see [Remote fleets](#remote-fleets-e2bdaytona-via---fleet)), and the provider holds the snapshot.

## Components

A local snapshot is a directory of archives plus metadata, and `restore` rebuilds a container from it:

### What a snapshot holds

Each snapshot is a directory under `~/.berth/snapshots/<appName>/<id>/` (mode `0700`):

| File | Contents |
|---|---|
| `image.tar` | A `docker commit` of the container: its filesystem and installed packages |
| `context-data.tar` | The files behind `/context` |
| `context-index-db.tar` | The `/context` tag index |
| `env.json` | The container's environment, minus credentials (mode `0600`) |
| `manifest.json` | The app's manifest |
| `metadata.json` | Id, app name, creation time, image tag, `/context` paths, and `redactedEnvNames` |

`restore` loads the image into Docker, unpacks `/context` and its index on the host, and starts a new container with them mounted in place before anything reads them.

**Credentials are left out.** Any environment variable whose name marks it as a credential (such as `*_TOKEN` or `*_KEY`) is withheld from `env.json` and listed in `redactedEnvNames`, and credentials never reach the committed image, because Berth delivers them by mounted file. `restore` warns you which ones the new sandbox is missing; set them again in whatever drives it. That's what makes a snapshot safe to copy to another machine. See [secrets](./secrets-reference.md#snapshots).

A snapshot also works on a container that crashed or was killed: it captures whatever was written before it died.

## Code

The commands are in [`packages/cli/src/commands/snapshot`](../packages/cli/src/commands/snapshot).

### Using it

Run these from the app's directory (they read its `berth.yml` for the app name), with `berth dev` running:

```bash
berth snapshot create                 # snapshot berth-dev-<appName>
berth snapshot list
berth snapshot restore <id>           # start a new container from it
```

`create` prints the snapshot's id (its creation time, such as `2026-08-02T12-00-00-000Z`) and the restore command to use.

| Command | Flag | What it does |
|---|---|---|
| `create` | `--container=<name>` | Snapshot a different container. Default `berth-dev-<appName>`. |
| `restore <id>` | `--name=<name>` | Name for the new container. Default `berth-restored-<appName>-<id>`. |

Restoring doesn't touch the original; it starts a new container alongside it.

### Remote fleets (E2B/Daytona) via `--fleet`

With `--fleet=<alias>`, the commands act on a deployed instance using the provider's native feature. The providers differ, so the commands do too:

```bash
berth snapshot create --fleet=<alias> [--instance=<id>] [--name=<name>]
berth snapshot restore <instance-id> --fleet=<alias>
berth snapshot fork <appName> --fleet=<alias> [--instance=<id>] [--name=<name>]
```

| Provider | `create` | `restore` | `fork` |
|---|---|---|---|
| **E2B** | Pauses the instance, memory and filesystem, under the same id | Resumes it | Not supported |
| **Daytona** | Saves the instance's filesystem as a named snapshot (`--name`, default `<appName>-<timestamp>`); the instance keeps running | Not supported | Clones it into a new, independent, running instance; the original keeps running |
| **Kubernetes** | Not supported | Not supported | Not supported |

`--instance` picks an instance by id; otherwise Berth looks up the app's instance in the fleet's local state. `create` and `fork` still read the app name from `berth.yml` in the current directory.

## Limits

- **Full copies.** Each snapshot is a complete image export plus a complete `/context` archive, with no deduplication. Repeated snapshots of a large sandbox use that much disk each time.
- **Mounts aren't captured.** `docker commit` skips bind mounts and volumes, so anything that lives on one (in `berth dev`, your project folder) isn't in the snapshot. `/context` is the exception; it's archived separately.
- **Context bus subscriptions aren't saved.** A restored sandbox starts a fresh bus, and apps subscribe again in `onAgentReady` as on any boot.
- **Restores are independent.** Two restores of one snapshot are two unrelated containers; nothing tracks or compares them.
- **Browser state is untested.** A browser profile is ordinary files, so cookies and local storage are probably in the image, but nothing checks this.
- **Remote snapshots are unit-tested only**, not yet run against live E2B or Daytona accounts.
