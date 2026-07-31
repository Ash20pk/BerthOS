# App Registry Reference (Phase 5)

Phase 5 opens the framework to external developers: a place to publish resident apps, discover what others have published, and scaffold a new project from a published one — plus making `@berth/sdk` itself something a genuinely external project can depend on. Per the PRD, this phase's registry/marketplace and SDK-openness goals are in scope here; usage-based billing and a hosted, multi-tenant service are not (the PRD's "first external revenue" is a Section 9 success metric, not a Phase 5 build item) — see the [README](../README.md)'s Status section.

## Architecture

`@berth/registry-server` (`packages/registry-server`) is a small Fastify HTTP API backed by `node:sqlite` (Node's built-in SQLite — same "real database, no ORM" instinct as Phase 4's sidecar index, minus an extra dependency) for metadata and a plain directory tree for blob storage.

```
berth publish --registry=<url> ──► POST /apps (multipart: manifest + bundle.tar.gz)
                                        │
                                        ▼
                              validateManifest() (same Zod schema berth.yml
                              validation always used) — malformed or
                              republished name+version is rejected, not
                              silently overwritten (versions are immutable,
                              same as npm)
                                        │
                                        ▼
                         SQLite index (name, version, description,
                         author, capabilities, exports, published_at)
                                        │
                                        ▼
                    blob store: <dataDir>/blobs/<name>/<version>/bundle.tar.gz

berth init --registry=<url> --template=<name> ──► GET /apps/:name/latest
                                                    GET /apps/:name/:version/download
                                                        │
                                                        ▼
                                          extract into the new project,
                                          rewrite berth.yml's name,
                                          vendor @berth/sdk (see below)
```

Run the server standalone with `pnpm --filter @berth/registry-server exec node dist/server.js` (env: `BERTH_REGISTRY_PORT`, `BERTH_REGISTRY_HOST`, `BERTH_REGISTRY_DATA_DIR`), or embed it via `createRegistryServer({ dataDir })` (returns a Fastify instance — call `.listen()` yourself; this is what the milestone test below does in-process on an ephemeral port).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/apps` | Publish — multipart fields `manifest` (raw `berth.yml` text), `bundle` (the gzipped tarball), `author` (optional) |
| `GET` | `/apps` | List the latest version of every published app; `?q=` filters by name/description substring |
| `GET` | `/apps/:name` | All published versions of one app, newest first |
| `GET` | `/apps/:name/:version` | One version's metadata (`:version` may be `latest`) |
| `GET` | `/apps/:name/:version/download` | The raw `bundle.tar.gz` bytes |

## `berth publish --registry=<url>`

Unchanged from Phase 1 up through building the production Docker image and writing `dist-bundle/publish-bundle.tar.gz` locally. What's new: that bundle is now **actually gzipped** (it was previously a plain tar mislabeled `.tar.gz` — harmless when nothing consumed it, but the registry serves it as `application/gzip` and `berth init --registry` gunzips it back down, so this got fixed as part of wiring publish up for real). With `--registry=<url>`, the CLI reads `berth.yml` and the bundle, and `POST`s both as multipart form data — no separate "create" step, no auth (there's no multi-tenant concept here; see Scope below).

## `berth init --registry=<url> --template=<name>`

Resolves `<name>`'s latest version, downloads and extracts the bundle as the new project, then rewrites the extracted `berth.yml`'s `name:` field to whatever the new project was named (a downloaded bundle is a real published app with its own name baked in, not a `{{name}}`-templated scaffold like the local `hello-world`/`browser-native` templates).

## Making `@berth/sdk` installable outside this monorepo

This is the other half of Phase 5's "open SDK for external developers" — and the part that surfaced the most real bugs, because it's the first time anything in this repo tried to run `@berth/sdk` **outside** the pnpm workspace that has always resolved it via symlinks.

`packages/sdk/scripts/build-external.mjs` (run as part of `pnpm --filter @berth/sdk build`) produces `packages/sdk/dist-external/berth-sdk.tgz`: an esbuild bundle of `index.ts`/`runtime.ts` with `@berth/manifest-schema` (the one workspace-internal dependency) inlined, `zod`/`protobufjs`/`yaml` (real npm packages) kept as declared `dependencies`, and hand-mirrored `.d.ts` declarations (including a copy of `@berth/manifest-schema`'s types, since `BerthManifest` leaks into `AppContext`'s public shape) so a consuming app's own `tsc` still type-checks — packaged with `npm pack` so it's a standard, installable tarball, not a hand-rolled archive.

`berth init`'s `vendorSdk()` (`packages/cli/src/commands/init.ts`) copies that tarball into the new project as `vendor/berth-sdk.tgz` and rewrites `package.json`'s `"@berth/sdk"` entry to `"file:./vendor/berth-sdk.tgz"` — replacing whatever was there (`"^0.1.0"` in the local templates, `"workspace:*"` in a real first-party app pulled from the registry; **neither resolves** once the project is copied anywhere outside this repo's pnpm workspace). It also pre-approves protobufjs's `postinstall` script via a generated `pnpm-workspace.yaml` (`allowBuilds: { protobufjs: true }`) — pnpm 10+ refuses to run any dependency's install script without explicit approval, and outside this monorepo there's no prior approval on record, so a first `pnpm install` would otherwise hard-fail on a script that's just a benign optional-dependency advisory.

This makes the vendoring step, not tarball construction, the part worth trusting: `vendor/berth-sdk.tgz` travels with the scaffolded project, so `pnpm install && pnpm build` succeeds with zero access to this monorepo — verified for real below, not assumed.

## Scope

- **Single-node, no auth.** Anyone who can reach the HTTP port can publish. There's no user/org model, no API key, no rate limiting. Fine for a local registry or a trusted internal one; not what you'd run as a public multi-tenant service.
- **No billing/usage metering.** The PRD's Persona 3 (Jordan, earning usage-based revenue from a published app) and the "first external revenue" success metric aren't implemented — they need a real payments integration and real paying users, neither of which exists yet.
- **`latest` means highest semver**, not most-recently-published — publishing `1.5.0` after `2.0.0` doesn't make `1.5.0` "latest".

## Verification status

**Fully verified**, via `packages/cli/test/registry-milestone.mjs` (real Fastify server, real SQLite, real filesystem blob storage — no mocks): it scaffolds a throwaway app from the local `hello-world` template, publishes it (a real Docker image build, same as any other `berth publish`) to a live registry instance, confirms the registry indexed and can list/search/serve it back, has a *second* `berth init` install it from the registry into a separate OS temp directory outside this repo's pnpm workspace, confirms `@berth/sdk` was correctly re-vendored there, runs a real `pnpm install` + `pnpm build`, and boots the scaffolded app's own vendored `@berth/sdk` runtime — asserting a real `ping` RPC round-trip over stdio.

## Running it yourself

```bash
pnpm build   # needed once so @berth/sdk's dist-external/ bundle exists
node packages/cli/test/registry-milestone.mjs
```

Requires Docker Desktop running (the publish step builds a real production image).
