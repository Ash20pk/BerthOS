# Semantic Filesystem Reference (Phase 4)

Phase 4 gives resident apps a filesystem that carries queryable metadata about *why* a file exists — `created_by`, `task`, `related_apps` — and a query API to find files by intent ("find files related to the auth bug") rather than by path. Per the PRD, this is a userspace primitive on a stock kernel, with **no dependency on Phase 3**.

## Architecture

`semantic-fs-daemon` (`packages/semantic-fs-daemon`, Go) mounts a FUSE filesystem at `$BERTH_CONTEXT_MOUNT` (default `/context`), backed by a real directory (`$BERTH_CONTEXT_DATA`, default `/var/berth/context-data`). Every read/write through `/context` is forwarded verbatim to that backing directory — resident apps see ordinary POSIX semantics — while every write also updates a SQLite sidecar index (`$BERTH_CONTEXT_INDEX_DB`) keyed by path.

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

A sidecar SQLite index was chosen over real extended attributes (the PRD's other suggested option): xattrs would round-trip through FUSE's getxattr/setxattr on every access, and the actual deliverable — a query API — needs SQL regardless of where the raw values live. `modernc.org/sqlite` (pure Go, no cgo) keeps the daemon a single static binary, cross-compiled the same way `agent-init` and `context-bus-daemon`'s Rust binaries are, via its own Docker builder stage in `base.Dockerfile`.

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

## Query semantics — v0, not real semantic search

`Query(text, limit)` lowercases the input into words and ranks rows by how many of those words appear as substrings in `path`, `created_by`, `task`, or `related_apps`. This is enough to satisfy the PRD's stated milestone (seeded fixtures tagged with a `task` like `"fix-auth-bug"`, found by querying `"auth bug"`) without pulling in an embedding model. **A real ranking model (embeddings, BM25, etc.) is future work** — this is intentionally the simplest thing that makes "query by intent, not by path" true today.

## Verification status

**Fully verified in this dev environment** — unlike Phase 3's Landlock gap, FUSE-in-Docker-Desktop-for-Mac works end-to-end: confirmed via a standalone mount test (`/dev/fuse` present, `fusermount3` present, a real `bazil.org/fuse` mount serves reads) and via `packages/docker-orchestrator/test/semantic-fs-milestone.mjs`, which builds the real image, starts a real container with `--device /dev/fuse --cap-add SYS_ADMIN`, writes and tags fixtures through the actual FUSE mount, and asserts query correctness against the real daemon (not a mock).

## Running it yourself

```bash
cd packages/docker-orchestrator
node test/semantic-fs-milestone.mjs
```
