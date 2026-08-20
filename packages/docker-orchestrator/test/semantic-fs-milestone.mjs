#!/usr/bin/env node
// Real, running verification of the Phase 4 milestone: "an agent can query
// 'find files related to the auth bug' and get relevant results" — against a
// seeded semantic FS with known file/metadata fixtures, per the PRD's stated
// Phase 4 verification approach.
//
// Boots ONE sandbox (filesystem app, extended in this phase with
// write_context_file/tag_context_file/query_context exports) and drives its
// live stdio RPC interface to: write two fixture files through the real FUSE
// mount at /context, tag one as related to "fix-auth-bug" and the other as
// unrelated, then query "auth bug" and assert only the tagged-matching file
// ranks in the results. Also confirms the FUSE mount is real (visible in the
// container's mount table, and the fixture bytes exist in the backing dir),
// not just that the control socket answers.
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer, createStdioRpcClient } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");

const docker = new Docker();

async function main() {
  const manifest = await loadManifest(join(FILESYSTEM_APP_DIR, "berth.yml"));

  console.log("Building filesystem's dev image (with Phase 4's semantic-fs-daemon baked in)...");
  await buildImage({ appDir: FILESYSTEM_APP_DIR, tag: "berth/filesystem:dev", target: "dev", docker });

  console.log("Starting filesystem's sandbox...");
  const running = await startContainer({
    image: "berth/filesystem:dev",
    name: "berth-semantic-fs-milestone-filesystem",
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: "/workspace/apps/filesystem",
    docker,
  });

  const containerLog = await startLogCapture(running.container);

  try {
    await waitFor(() => /"filesystem" ready/.test(containerLog.text()), 20000, "filesystem runtime ready");
    // The mount-table/backing-dir checks (execOutput, below) run only after
    // the attach-based rpc client is closed — mixing a docker exec() and a
    // container attach() as concurrent hijacked streams caused one observed
    // spurious timeout on the first RPC call in this container/dockerode
    // combination. Keeping them non-overlapping is cheap insurance either way.

    const rpc = await createRpcClient(running.container);

    console.log("\n--- Seeding fixtures through the real FUSE mount ---");
    const writeAuth = await rpc.call({
      id: "1",
      export: "write_context_file",
      input: { path: "auth-fix-notes.md", content: "Investigated the login session bug; root cause was a stale token cache." },
    });
    assert(!writeAuth.error, `write_context_file (auth) failed: ${writeAuth.error}`);

    const writeRefactor = await rpc.call({
      id: "2",
      export: "write_context_file",
      input: { path: "cleanup-notes.md", content: "Renamed a few internal helper functions for clarity." },
    });
    assert(!writeRefactor.error, `write_context_file (refactor) failed: ${writeRefactor.error}`);

    console.log("\n--- Tagging fixtures with task/related_apps metadata ---");
    const tagAuth = await rpc.call({
      id: "3",
      export: "tag_context_file",
      input: { path: "auth-fix-notes.md", task: "fix-auth-bug", relatedApps: ["browser-native"] },
    });
    assert(!tagAuth.error, `tag_context_file (auth) failed: ${tagAuth.error}`);

    const tagRefactor = await rpc.call({
      id: "4",
      export: "tag_context_file",
      input: { path: "cleanup-notes.md", task: "unrelated-refactor", relatedApps: [] },
    });
    assert(!tagRefactor.error, `tag_context_file (refactor) failed: ${tagRefactor.error}`);

    console.log("\n--- Querying: \"find files related to the auth bug\" ---");
    // Retried rather than a single shot: write_context_file's real FUSE write
    // and tag_context_file's control-socket call are two genuinely separate
    // paths into the daemon (kernel mount vs Unix socket) - nothing here
    // guarantees the daemon's own indexing of the write has landed before a
    // query issued immediately after tag_context_file returns, and a slower
    // CI runner is more likely to expose that gap than this dev machine.
    let results = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const query = await rpc.call({ id: `5-${attempt}`, export: "query_context", input: { text: "auth bug" } });
      assert(!query.error, `query_context failed: ${query.error}`);
      results = query.result?.results ?? [];
      if (results.length > 0) break;
      await sleep(500);
    }
    console.log("query results:", JSON.stringify(results, null, 2));

    assert(results.length > 0, "expected at least one query result");
    assert(results[0].path === "auth-fix-notes.md", `expected auth-fix-notes.md to rank first, got: ${results[0]?.path}`);
    assert(
      !results.some((r) => r.path === "cleanup-notes.md"),
      "cleanup-notes.md (tagged unrelated-refactor) should not match an 'auth bug' query",
    );
    assert(
      results[0].createdBy === "filesystem",
      `expected created_by to be automatically attributed to "filesystem", got: ${results[0]?.createdBy}`,
    );

    console.log("\n--- Purely-semantic match: zero keyword overlap with the query ---");
    // v0's keyword-only ranker dropped every zero-keyword-hit row outright —
    // this fixture and query share no substrings at all, so it only surfaces
    // if the embedding-similarity half of the hybrid ranking (Track 4) is
    // actually running, not silently falling back to keyword-only.
    const writeSession = await rpc.call({
      id: "6",
      export: "write_context_file",
      input: { path: "session-notes.md", content: "Users were getting logged out unexpectedly after a few minutes." },
    });
    assert(!writeSession.error, `write_context_file (session) failed: ${writeSession.error}`);

    const tagSession = await rpc.call({
      id: "7",
      export: "tag_context_file",
      input: { path: "session-notes.md", task: "diagnosed why users were getting logged out unexpectedly", relatedApps: [] },
    });
    assert(!tagSession.error, `tag_context_file (session) failed: ${tagSession.error}`);

    const semanticQuery = await rpc.call({ id: "8", export: "query_context", input: { text: "authentication failure investigation" } });
    assert(!semanticQuery.error, `query_context (semantic) failed: ${semanticQuery.error}`);

    const semanticResults = semanticQuery.result?.results ?? [];
    console.log("semantic query results:", JSON.stringify(semanticResults, null, 2));
    assert(
      semanticResults.some((r) => r.path === "session-notes.md"),
      `expected session-notes.md (zero keyword overlap, semantically related) to surface — embeddings may not be running: ${JSON.stringify(semanticResults)}`,
    );
    assert(
      !semanticResults.some((r) => r.path === "cleanup-notes.md"),
      "cleanup-notes.md (tagged unrelated-refactor, also zero keyword overlap) should not pass the embedding-similarity threshold either",
    );

    rpc.close();

    const embeddingsFailed = /\[semantic-fs:embeddings\] .*failed/.test(containerLog.text());
    assert(!embeddingsFailed, `embeddings.ts logged a failure — check container log for details:\n${containerLog.text()}`);

    console.log("\nConfirming the fixture bytes landed in the real backing dir (not just visible via the mount)...");
    const backingLs = await execOutput(running.container, ["ls", "/var/berth/context-data"]);
    assert(backingLs.includes("auth-fix-notes.md"), `expected auth-fix-notes.md in backing dir, got: ${backingLs}`);
    assert(backingLs.includes("cleanup-notes.md"), `expected cleanup-notes.md in backing dir, got: ${backingLs}`);

    console.log("Confirming the FUSE mount is real (visible in the container's mount table)...");
    const mounts = await execOutput(running.container, ["cat", "/proc/mounts"]);
    assert(/\s\/context\sfuse/.test(mounts), `expected /context to appear as a fuse mount, got: ${mounts}`);
    console.log("/context is a real FUSE mount.");

    console.log("\nPASS — query-by-intent over a seeded, real FUSE-backed semantic FS returned the correct fixture.");

    // --- REMEDIATION.md 1.14: a dead daemon must be an error, not silence. ---
    //
    // Deliberately last: it kills the daemon, so nothing after it can query.
    //
    // The failure this replaces was the worst kind — `query()` returned an
    // empty array, indistinguishable from "nothing matched", so retrieval,
    // checkpoints, sessions and traces degraded to silent data loss while
    // every call reported success. So the assertion is not "the query fails"
    // in the abstract: it is that the *same query that just returned a
    // fixture* now returns an error rather than `[]`.
    //
    // Driven through the shipped createStdioRpcClient rather than this file's
    // local copy, because that one reattaches if its stream has gone — and a
    // Docker attach connection quietly ending, while the container and app are
    // both healthy, is exactly what made this assertion impossible to write
    // before (see stdio-rpc.ts).
    console.log("\n--- Killing semantic-fs-daemon and re-running the query that just worked ---");
    // The daemon lives in the per-sandbox sidecar since BUILD_PLAN M1.1;
    // kill it where it actually runs. The in-sandbox pkill stays for the
    // legacy (BERTH_DISABLE_FS_SIDECAR=1) path, where it is the daemon's home.
    await docker.getContainer("berth-semantic-fs-milestone-filesystem-fs").kill().catch(() => {});
    await execOutput(running.container, ["pkill", "-9", "-f", "semantic-fs-daemon"]).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const resilientRpc = await createStdioRpcClient(running.container, docker);
    const afterKill = await resilientRpc.call({
      id: "after-kill",
      export: "query_context",
      input: { text: "find files related to the auth bug" },
    });
    console.log("query after the daemon died:", JSON.stringify(afterKill));
    assert(
      afterKill.error,
      `querying a dead semantic-fs daemon returned success instead of an error — this is REMEDIATION.md 1.14's silent data loss: ${JSON.stringify(afterKill)}`,
    );
    assert(
      /semantic-fs|control socket/i.test(afterKill.error),
      `the error names neither the daemon nor the socket, so whoever reads it cannot tell what broke: ${afterKill.error}`,
    );

    console.log("\nPASS — a dead semantic-fs daemon surfaces as an error, not as an empty result set (REMEDIATION.md 1.14).");
  } finally {
    await containerLog.stop();
    await stopContainer(running.container);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function execOutput(container, cmd) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);

  let buffer = "";
  stdout.on("data", (chunk) => (buffer += chunk.toString("utf-8")));
  stderr.on("data", (chunk) => (buffer += chunk.toString("utf-8")));

  await new Promise((resolve) => stream.on("end", resolve));
  return buffer;
}

async function startLogCapture(container) {
  const raw = await container.logs({ follow: true, stdout: true, stderr: true, tail: 0 });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(raw, stdout, stderr);

  let buffer = "";
  stdout.on("data", (chunk) => (buffer += chunk.toString("utf-8")));
  stderr.on("data", (chunk) => (buffer += chunk.toString("utf-8")));

  return { text: () => buffer, stop: async () => raw.destroy() };
}

// One attach connection reused across every call — see
// capability-enforcement.mjs's comment on why ending the stream per-call
// would silently break every subsequent RPC call against this container.
async function createRpcClient(container) {
  const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
  // Terminates the attach options object docker-modem sends as this POST's
  // body straight into the container's stdin, so it can't concatenate onto the
  // first real request — see @berth/docker-orchestrator's stdio-rpc.ts for the
  // full explanation.
  stream.write("\n");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);

  let buffer = "";
  const pending = new Map();

  stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        pending.get(parsed.id)?.(parsed);
        pending.delete(parsed.id);
      } catch {
        // not a JSON line — ignore
      }
    }
  });

  // The very first write right after attach() occasionally never reaches
  // the container's stdin — the HTTP upgrade completing (which is what
  // attach()'s promise waits for) doesn't guarantee Docker has finished
  // wiring the multiplexed stream to the container's actual fd yet. A retry
  // (the request is idempotent for every op this test uses) is more robust
  // than guessing a fixed grace delay.
  function attempt(request, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request.id);
        reject(new Error(`timed out waiting for RPC response to ${JSON.stringify(request)}`));
      }, timeoutMs);
      pending.set(request.id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      stream.write(JSON.stringify(request) + "\n");
    });
  }

  return {
    async call(request) {
      try {
        return await attempt(request, 4000);
      } catch {
        console.log(`(no response to ${request.export} within 4s — retrying once)`);
        return attempt(request, 10000);
      }
    },
    close() {
      stream.end();
    },
  };
}

async function waitFor(predicate, timeoutMs, description) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for: ${description}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nSEMANTIC FS MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
