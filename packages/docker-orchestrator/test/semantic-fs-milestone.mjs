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
import { buildImage, startContainer, stopContainer } from "../dist/index.js";

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
    const query = await rpc.call({ id: "5", export: "query_context", input: { text: "auth bug" } });
    assert(!query.error, `query_context failed: ${query.error}`);

    const results = query.result?.results ?? [];
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

    rpc.close();

    console.log("\nConfirming the fixture bytes landed in the real backing dir (not just visible via the mount)...");
    const backingLs = await execOutput(running.container, ["ls", "/var/berth/context-data"]);
    assert(backingLs.includes("auth-fix-notes.md"), `expected auth-fix-notes.md in backing dir, got: ${backingLs}`);
    assert(backingLs.includes("cleanup-notes.md"), `expected cleanup-notes.md in backing dir, got: ${backingLs}`);

    console.log("Confirming the FUSE mount is real (visible in the container's mount table)...");
    const mounts = await execOutput(running.container, ["cat", "/proc/mounts"]);
    assert(/\s\/context\sfuse/.test(mounts), `expected /context to appear as a fuse mount, got: ${mounts}`);
    console.log("/context is a real FUSE mount.");

    console.log("\nPASS — query-by-intent over a seeded, real FUSE-backed semantic FS returned the correct fixture.");
  } finally {
    await containerLog.stop();
    await stopContainer(running.container);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
