# Python SDK Reference (Slice 1 — core)

`packages/sdk-python` (`berth_sdk` on PyPI-style import) is a real second-language SDK for Berth resident apps — not a stub, not a design doc. Per the PRD's Section 11 open question ("Primary SDK language: Python or TypeScript?") and Section 4.1's "Resident app SDK (Python / TypeScript)" stack line, this closes that gap for real, split into two branches given its size: this slice (manifest + RPC + a real demo app, proving wire-protocol compatibility) and a follow-up slice (the context-bus client + `entrypoint.sh`'s runtime-selection wiring — see `docs/sdk-python-context-bus-reference.md` once that lands).

## What's reused vs. rewritten

Confirmed before writing any code: the manifest shape (plain YAML) and the RPC protocol (line-delimited JSON) are genuinely language-agnostic wire contracts, not TypeScript-specific runtime behavior — so this SDK targets them directly rather than porting `@berth/sdk`'s TypeScript:

- **`berth_sdk/manifest.py`** — a pydantic model of the exact same manifest shape `@berth/manifest-schema`'s `schema.ts` defines (same field names, same `namespace:action:scope` capability grammar, same glob-on-scope-only matching), loaded via `pyyaml`. Not a port — an independent implementation validating the same data shape.
- **`berth_sdk/rpc.py`** — the identical newline-delimited JSON protocol from `rpc.ts`: `{id, export, input}` in, `{id, result}`/`{id, error}` out, over stdio and (for multi-app-per-sandbox mode) an additional Unix socket via `socketserver.ThreadingUnixStreamServer`.
- **`berth_sdk/app.py`/`runtime.py`** — the boot sequence (load manifest → import the app module → assert exports match manifest → run hooks → serve RPC) mirrors `runtime.ts`'s logic, but the *implementation* is idiomatic Python (`importlib.util` instead of dynamic `import()`, a module-level `app = define_app(...)` attribute instead of a default export, since Python has no default-export convention).
- **`generate_capability_policy.py`/`run_lifecycle.py`** — real Python equivalents of the two Node scripts `entrypoint.sh` already ran per-app. Needed because a pure-Python app has no `node_modules/@berth/sdk` for the existing Node scripts to live in — `agent-init` (Rust) doesn't care which language wrote `capability-policy.json`, only that the shape matches.

## How `entrypoint.sh` picks a runtime

Single-app mode only (see "What's deliberately out of scope" below) gained an additive `BERTH_APP_RUNTIME=python|node` branch — defaults to `node`, byte-for-byte identical to before this change when unset. When `python`:

1. `PYTHONPATH` is set to the bind-mounted `packages/sdk-python` source — the same role a pre-existing `node_modules/@berth/sdk` symlink plays for a TypeScript app. No `pip install` needed in dev mode.
2. `python3 -m berth_sdk.run_lifecycle` replaces the Node lifecycle script.
3. `python3 -m berth_sdk.generate_capability_policy` replaces the Node policy generator.
4. `agent-init` execs `python3 -m berth_sdk.runtime` instead of the Dockerfile's baked-in Node `CMD` — for Python mode, that `CMD` value is simply never used.

`base.Dockerfile` bakes `pydantic`/`pyyaml` into every image (not a per-app `on_install` step) — `run_lifecycle.py` itself needs to `import berth_sdk` (and thus these) before any app-specific `on_install` has had a chance to run, the same chicken-and-egg reasoning that makes `@berth/sdk`'s own `node_modules` already resolvable before a TS app's `on_install` runs.

## The demo app — `apps/hello-world-py`

A minimal real app (one `greet` export) proving the full round trip inside a real container: `packages/docker-orchestrator/test/python-sdk-milestone.mjs` boots it with `BERTH_APP_RUNTIME=python`, sends a real `{id, export, input}` line over the container's actual stdio (the identical `container.attach()` pattern every other milestone test here uses against Node apps), and asserts a correct `{id, result}` comes back — plus a real `{id, error}` for an unknown export, not silence.

## A real, non-Python-specific bug this surfaced

Getting the milestone test to pass reliably surfaced a genuine bug in `dockerode`/`docker-modem` (not something specific to this SDK): `container.attach({stream, stdin, stdout, stderr, hijack: true})` is a POST request, and `docker-modem`'s `dial()` unconditionally does `data = JSON.stringify(opts._body || opts)` for any POST — so the **attach options themselves** get serialized and sent as a request body with no trailing newline. Those bytes land as the first thing written to the container's real stdin once the connection upgrades, silently concatenating onto whatever the very first real RPC write is (Python's `readline()`-style buffering — and Node's `readline.createInterface`, identically — just keep accumulating until they see a `\n`). The fix: prepend `"\n"` to the first write to force a real line break, rather than the timing-delay-based mitigations used elsewhere in this repo's other milestone tests for what was very likely this exact same root cause, previously undiagnosed.

## What's deliberately out of this slice

- **Semantic-fs's tag/query control API.** Direct file I/O against the FUSE-mounted `/context` already works from any process with zero SDK code — that's this SDK's honest v1 scope for context access. The richer control socket (register/tag/query) stays TypeScript-only.
- **Context-bus pub/sub** — closed in a follow-up slice, not deferred indefinitely: see [Python SDK context-bus reference](./sdk-python-context-bus-reference.md) for the compiled-protobuf client and a real cross-language pub/sub proof.
- **Multi-app-mode wiring.** `entrypoint.sh`'s `BERTH_APP_RUNTIME` branch only exists in the single-app path. A Python companion app in a `--apps` multi-app sandbox isn't wired up.
- **Production images / `berth deploy` for Python apps.** `berth dev`'s CLI doesn't auto-detect a Python app (no `package.json` to key off of) — `python-sdk-milestone.mjs` drives `buildImage()`/`startContainer()` directly rather than through the `berth` CLI. `berth init --template=python` or equivalent CLI-level support is future work.
- **A packaged, pip-installable `berth-sdk` distribution.** Dev mode resolves it via `PYTHONPATH` pointed at the bind-mounted source, mirroring the TS SDK's own dev-mode symlink resolution — there's no `sdist`/`wheel` publishing step here, matching Phase 5's own TS SDK story only partially (that one has `build-external.mjs` bundling for real external consumption; this doesn't yet).
