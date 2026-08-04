# Semantic Filesystem Reference (Phase 4)

Phase 4 gives resident apps a filesystem that carries queryable metadata about *why* a file exists — `created_by`, `task`, `related_apps` — and a query API to find files by intent ("find files related to the auth bug") rather than by path. This is a userspace primitive on a stock kernel, with **no dependency on Phase 3**.

## Architecture

`semantic-fs-daemon` (`packages/semantic-fs-daemon`, Go) mounts a FUSE filesystem at `$BERTH_CONTEXT_MOUNT` (default `/context`), backed by a real directory (`$BERTH_CONTEXT_DATA`, default `/var/berth/context-data`). Every read/write through `/context` is forwarded verbatim to that backing directory — resident apps see ordinary POSIX semantics — while every write also updates a SQLite sidecar index (`$BERTH_CONTEXT_INDEX_DB`, default `/var/berth/context-index.db`) keyed by path.

```
resident app ──┐
  (filesystem)  │  read()/write() through /context (FUSE, ordinary POSIX)
                ▼
        semantic-fs-daemon ──► backing dir ($BERTH_CONTEXT_DATA)
                │
                └──► SQLite index (created_by, task, related_apps)
                        ▲
  register/tag/query ───┘  (Unix control socket, length-prefixed JSON)
```

The control socket path is `$BERTH_SEMANTIC_FS_SOCKET` (default `/tmp/berth-semantic-fs.sock`) — the semantic-fs equivalent of the context bus's `$BERTH_CONTEXT_BUS_SOCKET` (see [Context Bus Reference](./context-bus-reference.md)).

A sidecar SQLite index was chosen over real extended attributes (the other option considered): xattrs would round-trip through FUSE's getxattr/setxattr on every access, and the actual deliverable — a query API — needs SQL regardless of where the raw values live. `modernc.org/sqlite` (pure Go, no cgo) keeps the daemon a single static binary, cross-compiled the same way `agent-init` and `context-bus-daemon`'s Rust binaries are, via its own Docker builder stage in `base.Dockerfile`.

**`created_by` is inferred automatically**, not declared: every FUSE request carries the calling process's pid, and the daemon maps pid → app name via a registry populated by `ctx.semanticFs.register({app})` (called once, in `onAgentReady` — the same pattern as `ctx.contextBus.register()`). A resident app gets attribution for free just by writing through `/context`.

**`task` and `related_apps` are explicit**, not inferred — the daemon has no way to know an app's task-level intent from raw POSIX writes, so `ctx.semanticFs.tag(path, { task, relatedApps })` is a deliberate, separate call after a write.

## Using it from a resident app

```ts
app.onAgentReady(async (ctx) => {
  await ctx.semanticFs.register({ app: "filesystem" });
});

app.export({
  name: "write_context_file",
  handler: async ({ path, content }) => {
    await writeFile(join("/context", path), content, "utf-8");
    // created_by is attributed automatically from this process's registered pid
  },
});

app.export({
  name: "read_context_file",
  handler: async ({ path }) => ({ content: await readFile(join("/context", path), "utf-8") }),
});

app.export({
  name: "tag_context_file",
  handler: async ({ path, task, relatedApps }) => {
    await ctx.semanticFs.tag(path, { task, relatedApps });
  },
});

app.export({
  name: "query_context",
  handler: async ({ text }) => ({ results: await ctx.semanticFs.query(text) }),
});
```

`ctx.semanticFs` falls back to an in-process no-op (`createLocalSemanticFs`, returning `[]` from `query`) when no daemon is reachable — e.g. a bare `node dist/index.js` outside a sandbox — mirroring the context bus's Phase-1-local-no-op fallback pattern.

## Interaction with Phase 3's capability tokens

Writing through `/context` is a real filesystem write, so it's subject to the same Landlock write-path restriction as any other path: an app must declare `filesystem:write:/context` in its `berth.yml` to write there, exactly like `filesystem:write:/workspace`. This falls out of the existing Phase 3 design with no changes needed to `generate-capability-policy.ts` — the control socket (`register`/`tag`/`query`) is a Unix socket connection, not a write-ish filesystem operation, so it's reachable regardless of declared capabilities (same reasoning as the context-bus socket).

## Query semantics — hybrid keyword + embedding similarity

`Query(text, queryEmbedding, queryModel, limit)` combines the original v0 keyword-overlap score (how many query words appear as substrings in `path`, `created_by`, `task`, or `related_apps`) with a cosine-similarity term against a stored embedding, when one exists for that row and it came from the same model as the query. A row is included if it clears *either* signal — `keywordScore > 0 || cosineSim >= 0.2` — not just keyword hits, since v0 silently dropped every zero-keyword-hit row regardless of how semantically close it was. Keyword hits (small integers) still dominate ranking over the 0–1 cosine range, so exact-name/author lookups keep winning; purely-semantic matches rank among themselves by cosine.

**Compute-on-tag, not compute-on-write.** `write_context_file` (`apps/filesystem`) does a raw `fs.writeFile` into the FUSE mount — it never calls into `@berth/sdk` at all, so there's no JS-reachable hook on the write path itself. The only control-plane calls that do reach JS are `register`/`tag`/`query`, so embeddings are computed from `tag()`'s `task + relatedApps + path` text (the same text the keyword ranker already uses) and from `query()`'s query text — not from file content. A file that's written but never tagged keeps keyword-only scoring; that's a deliberate v0 boundary, not a bug.

**Model**: `Xenova/all-MiniLM-L6-v2` (quantized, 384-dim, L2-normalized) via `@xenova/transformers`, computed in `@berth/sdk` (`src/semantic-fs/embeddings.ts`) — the daemon itself (Go) never runs any ML model, it only stores a `BLOB` vector per path (`files_vec` sidecar table, `internal/index/vector.go`'s plain-Go cosine similarity — `modernc.org/sqlite` has no C extension support for a real vector index, and brute-force is fine at this table's scale) and computes cosine similarity in `Query()`.

**Weights are baked in at `pnpm install` time**, not fetched at container runtime — `packages/sdk/scripts/prefetch-embedding-model.mjs` (this package's `postinstall`) downloads them into `packages/sdk/models/`, the one point in the pipeline with guaranteed network access (production images are staged via `pnpm deploy` on the host before the Docker build context even exists; containers have no guaranteed runtime internet). `embeddings.ts` sets `env.allowRemoteModels = false` — a missing cache fails closed (falls back to keyword-only ranking) rather than reaching out to the Hub from inside a sandbox.

**Three non-obvious fixes were needed to make this actually run under plain Node** (found by hand, not assumed — see the git history for the real failures each one fixed):
1. `onnxruntime-node` (a hard dependency of `@xenova/transformers` on Node, preferred over the WASM backend unconditionally) `require()`s a prebuilt native binary with **no try/catch** — it crashes the whole import if that binary doesn't load, which it won't on Alpine (musl; the prebuilt is glibc-linked). This isn't fixed in newer versions either — `@huggingface/transformers` (the successor package) has the identical unconditional import. Fixed via a root `package.json` `pnpm.overrides`: `"onnxruntime-node": "npm:onnxruntime-web@1.14.0"` — both specifiers now resolve to the same real, working WASM backend, so it doesn't matter that the library always prefers "the node one" when running in Node.
2. Same failure mode, different dependency: `sharp` (image support this SDK never uses — only text/feature-extraction) is also a hard, unconditional top-level import, and throws explicitly (`Unable to load image processing library`) if it's falsy. Fixed via `packages/sdk/vendor/sharp-stub/` — a two-file local package (aliased over `sharp` via the same `pnpm.overrides`) that's truthy but throws loudly if anything ever actually calls it, which nothing in a text-only pipeline does.
3. `onnxruntime-web`'s multi-threaded WASM path spawns a `Worker` from a `blob:` URL — unsupported by Node's `worker_threads` (`ERR_WORKER_PATH`), and confirmed by hand to **hang indefinitely** rather than throw. `embeddings.ts` sets `env.backends.onnx.wasm.numThreads = 1` unconditionally, before creating the pipeline, to avoid that code path entirely.

External consumers of `@berth/sdk` (via `berth init --registry=<url>`) don't inherit fixes #1/#2 — those are workspace-level `pnpm.overrides`, scoped to this monorepo's own `pnpm install`. That's fine: `embedText()`/`loadPipeline()` wrap the dynamic `import("@xenova/transformers")` in a try/catch, and a Node dynamic `import()` failure (unlike the worker-thread hang) is a normal rejected promise — so an external consumer without these overrides gets a clean fallback to keyword-only ranking (logged, not crashed), not a broken build. Fix #3 (`numThreads = 1`) is set unconditionally in `embeddings.ts` itself, so every consumer gets it regardless.

**Calibration note**: `embeddingMatchThreshold` (0.2, in `index.go`) was set from real measured cosine similarities for this SDK's actual embedding input shape — short `task + relatedApps + path` strings, not full sentences. A genuinely related pair scored ~0.30; an unrelated pair in the same short/tag-like style scored ~0.04. 0.2 sits clear of both. This is a real, hand-tuned number for this text style, not an arbitrary constant — if the embedded text shape changes materially (e.g. if a future pass embeds full file content), re-calibrate rather than assuming this threshold still holds.

## Consuming query_context from `@berth/agents`

`query_context` returns metadata only (`path`/`task`/`relatedApps`/timestamps) — no file content — so calling it directly still needs a `read_context_file` per hit to get anything an LLM can reason over. `@berth/agents`' `createSemanticFsRetriever()` (see the [Agents Reference](./agents-reference.md)'s "Retrieval" section) wraps that two-step round trip as a single `search_context` tool, via `createAgent({retriever: "semantic-fs"})`.

## Verification status

**Fully verified in this dev environment** — unlike Phase 3's Landlock gap (see [Capability Tokens Reference](./capability-tokens-reference.md)), FUSE-in-Docker-Desktop-for-Mac works end-to-end: confirmed via a standalone mount test (`/dev/fuse` present, `fusermount3` present, a real `bazil.org/fuse` mount serves reads) and via `packages/docker-orchestrator/test/semantic-fs-milestone.mjs`, which builds the real image, starts a real container with `--device /dev/fuse --cap-add SYS_ADMIN`, writes and tags fixtures through the actual FUSE mount, and asserts query correctness against the real daemon (not a mock) — including a purely-semantic match (zero keyword overlap with the query) that v0's keyword-only ranker would have silently dropped, confirming the embedding half of the hybrid ranking is actually running inside Alpine, not silently falling back.

## Running it yourself

```bash
cd packages/docker-orchestrator
node test/semantic-fs-milestone.mjs
```
