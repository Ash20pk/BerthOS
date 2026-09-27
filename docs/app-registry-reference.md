# App registry reference

The app registry is a small server you run yourself for sharing resident apps. `berth publish` uploads an app to it, and `berth init --registry` starts a new project from one. Use it to share apps inside a team or on a closed network.

## Use it

Start a registry:

```bash
npm install -g @berthos/registry-server
berth-registry     # listens on http://127.0.0.1:4873
```

Publish an app from its directory:

```bash
berth publish --registry http://localhost:4873
```

The first publish of a name prints an owner token. Save it; it isn't shown again. Every later version of that name needs it:

```bash
berth publish --registry http://localhost:4873 --token <owner-token>
# or: BERTH_REGISTRY_TOKEN=<owner-token> berth publish --registry http://localhost:4873
```

Start a new project from a published app:

```bash
berth init my-app --registry http://localhost:4873 --template notes
```

For a registry on another machine, serve it over HTTPS so the owner token isn't sent in the clear. See [TLS](./tls-reference.md).

## How it works

`berth publish` builds the app's production Docker image, packs the app directory into `dist-bundle/publish-bundle.tar.gz` (skipping `node_modules`, `dist-bundle` and `vendor`), and uploads the bundle with the app's `berth.yml`. The registry validates the manifest with the same schema `berth dev` uses, stores the metadata in SQLite and the bundle on disk. The Docker image stays local; only the source bundle is uploaded.

`berth init --registry` downloads the latest version of the named app, extracts it as the new project, sets `name:` in its `berth.yml` to the new project's name, vendors the SDK (see below), runs `pnpm install` and validates the manifest.

Without `--registry`, `berth publish` still builds the image and writes the bundle locally, and uploads nothing.

## Commands

| Command | Flags |
|---|---|
| `berth publish` | `--registry <url>`, `--token <value>` (or `BERTH_REGISTRY_TOKEN`), `--author <name>`, `--ca <path>`, `--insecure` |
| `berth init [name]` | `--registry <url>`, `--template <app name>` (prompted if omitted), `--ca <path>`, `--insecure` |

`--ca` and `--insecure` are described in [TLS](./tls-reference.md#clients).

## Server configuration

| Variable | Default | Meaning |
|---|---|---|
| `BERTH_REGISTRY_PORT` | `4873` | Port to listen on |
| `BERTH_REGISTRY_HOST` | `127.0.0.1` | Address to bind. Set `0.0.0.0` to accept remote connections. |
| `BERTH_REGISTRY_DATA_DIR` | `./.berth-registry-data` | Holds `registry.sqlite` and `blobs/<name>/<version>/bundle.tar.gz` |
| `BERTH_REGISTRY_TLS_*` | unset | Serve HTTPS. See [TLS](./tls-reference.md). |

To embed it, `createRegistryServer({ dataDir, tls?, logger? })` returns a Fastify instance; call `.listen()` yourself.

Uploads are limited to 100 MB.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/apps` | Publish. Multipart fields: `manifest` (the `berth.yml` text), `bundle` (the gzipped tarball), `author` (optional). Needs `Authorization: Bearer <ownerToken>` for any name already published. Returns `201` with `name`, `version`, `publishedAt`, and `ownerToken` on a name's first publish. |
| `GET` | `/apps` | Latest version of every app. `?q=` filters by name or description. |
| `GET` | `/apps/:name` | Every version of one app, newest first |
| `GET` | `/apps/:name/:version` | One version's metadata. `:version` may be `latest`. |
| `GET` | `/apps/:name/:version/download` | The `bundle.tar.gz` bytes |
| `GET` | `/health` | `{"status":"ok"}` |

Metadata fields: `name`, `version`, `description`, `author`, `capabilities`, `exports`, `publishedAt`.

Errors are JSON `{"error": "..."}`:

| Status | When |
|---|---|
| `400` | Missing `manifest` or `bundle`, or the manifest is invalid |
| `401` | The name is already published and the owner token is missing or wrong |
| `404` | No such app or version |
| `409` | That name and version are already published |

`latest` means the highest version number, not the most recently published. Publishing `1.5.0` after `2.0.0` leaves `2.0.0` as latest.

## Making `@berthos/sdk` installable outside this monorepo

A scaffolded project has to install `@berthos/sdk` without this repo's pnpm workspace. So `berth init` copies a self-contained SDK tarball into the project as `vendor/berth-sdk.tgz` and points `package.json` at it with `"@berthos/sdk": "file:./vendor/berth-sdk.tgz"`. It also writes a `pnpm-workspace.yaml` with `allowBuilds: { protobufjs: true }`, so pnpm 10+ runs the SDK dependency's install script without asking.

The tarball, `packages/sdk/dist-external/berth-sdk.tgz`, is built by `pnpm --filter @berthos/sdk build`. It bundles the SDK and its manifest types, and depends on `zod`, `protobufjs` and `yaml` from npm. If `berth init` can't find it, it warns and leaves the dependency unchanged.

## Scope

- **Self-hosted, single node.** No users, organisations or rate limiting. The only credential is the per-name owner token. Fine for a local or trusted internal registry, not for a public service.
- **Owner tokens can't be recovered or rotated.** Lose the token and you can't publish new versions of that name.
- **No billing or usage metering.**
- A public, hosted registry is on the [roadmap](../ROADMAP.md#later).
