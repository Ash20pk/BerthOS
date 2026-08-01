# Computer Snapshots Reference

`berth snapshot create/restore/list` is a real, if deliberately narrow, MVP of the PRD's "Computer Snapshots" primitive (Section 4.4: "Checkpoint the entire OS state... Rollback or fork at any point. Git for agent computers.") — not the full vision, which spans browser tabs, active tokens, and fork-and-run-in-parallel. This primitive has no build phase in the PRD's Section 7 at all; it's vision/primitive-level language only, so this is a standalone addition.

## How it works

- **`berth snapshot create`** (`packages/cli/src/commands/snapshot/create.ts`): finds the running dev container (`berth-dev-<appName>` by default), then calls `@berth/docker-orchestrator`'s `createSnapshot()`:
  - `container.commit()` — a **real Docker image commit**, capturing the container's actual filesystem and installed packages as a new image layer, not a re-run of `on_install`.
  - `container.getArchive({path: BERTH_CONTEXT_DATA})` — a **real tar archive** of semantic-fs's backing directory (its SQLite metadata index plus the files it tracks), saved alongside the image.
  - The container's real `Config.Env` (its actual inherited environment, not just this CLI process's own) plus its manifest are saved too, so a restore can reproduce the same running configuration.
  - Everything lands under `~/.berth/snapshots/<appName>/<timestamp>/`.
- **`berth snapshot restore <id>`**: loads the saved image tar back into the local Docker daemon (`docker load` equivalent), extracts the context-data archive into a **fresh host directory first** — not injected into an already-running container via `putArchive`, which would race `semantic-fs-daemon`'s own SQLite open at boot, a real ordering hazard — then starts a new container from the restored image with that directory bind-mounted at the same `BERTH_CONTEXT_DATA` path via a new, additive `extraBinds` option on `startContainer()`.
- **`berth snapshot list`**: reads the metadata files back.

## Why the milestone test uses a production image, not a dev one

A `berth dev` container bind-mounts the whole workspace root at `/workspace` from the host — so a file written there during dev already lives on the host filesystem, and would trivially "survive" being committed/restored regardless of whether snapshotting actually works. `packages/docker-orchestrator/test/snapshot-milestone.mjs` instead builds and boots a **production** (self-contained, no bind mount) `apps/filesystem` image, so a file written via RPC genuinely lands in the container's own writable layer — making the test a real proof that `docker commit()` captured it, not an artifact of the bind mount.

## What's explicitly deferred (named here, not silently promised)

- **Browser tabs/sessions.** A Chromium profile directory is just files under the committed filesystem layer, so cookies/local storage are *incidentally* captured by `docker commit` — but this MVP never verifies or exercises that path. Don't rely on it without separately confirming it for whatever browser-native workflow you have in mind.
- **"Active tokens."** `BERTH_TOKEN_SECRET` (backing `@berth/sdk`'s HMAC capability tokens) is generated fresh per container boot by `entrypoint.sh` and is deliberately **not** captured — restoring with the *old* secret would be a real security regression (a stale, potentially-leaked secret persisting across restores), not a missing feature.
- **Context-bus in-flight state.** The Rust daemon's live subscriber list is process memory, not disk — a restored container boots a fresh daemon with zero subscribers, and each app re-subscribes via its own `on_agent_ready` hook, exactly as it would on any first boot. Nothing to restore here by design.
- **"Fork and run in parallel."** Two `berth snapshot restore` calls from the same snapshot are just two independent containers — no orchestration, family-tracking, or diffing between the resulting forks is attempted.
- **Storage efficiency.** Each snapshot is a full image export (`docker save`-equivalent tarball) plus a full context-data tarball — not layer-deduplicated or incremental. Snapshotting a large, long-lived sandbox repeatedly will use disk proportional to its full size each time.
