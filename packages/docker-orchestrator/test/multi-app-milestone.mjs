#!/usr/bin/env node
// Real, running verification of Track 1's actual gap: today,
// context-bus-milestone.mjs runs a second app via a raw `docker exec` that
// bypasses agent-init entirely, so that companion app gets ZERO Landlock
// enforcement. This starts filesystem (primary) + code-editor (companion)
// via the real --apps multi-app path (startContainer's `apps` option +
// entrypoint.sh's multi-app branch) and asserts BOTH processes log their own
// `agent-init` ruleset status line — proving each one is its own real,
// independently-enforced process, not one enforced process plus an
// unenforced passenger.
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer, invokeAppExport } from "../dist/index.js";
import { resolveDevBindMount } from "../../cli/dist/util/workspace.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const CODE_EDITOR_APP_DIR = join(REPO_ROOT, "apps", "code-editor");

const docker = new Docker();

async function main() {
  const filesystemManifest = await loadManifest(join(FILESYSTEM_APP_DIR, "berth.yml"));
  const codeEditorManifest = await loadManifest(join(CODE_EDITOR_APP_DIR, "berth.yml"));

  console.log("Building filesystem's dev image (shared by both apps in this container)...");
  await buildImage({ appDir: FILESYSTEM_APP_DIR, tag: "berth/filesystem:dev", target: "dev", docker });

  const apps = [
    { name: "filesystem", workingDir: "/workspace/apps/filesystem", manifest: filesystemManifest },
    { name: "code-editor", workingDir: "/workspace/apps/code-editor", manifest: codeEditorManifest },
  ];

  // The real `berth dev` mount layout, via the CLI's own helper rather than a
  // hand-rolled bind — the same reason dev-workspace-mount-milestone.mjs
  // imports it. This used to be one read-WRITE bind of the repository root at
  // /workspace, and the write below landed `multi-app-test.txt` in the
  // developer's own repository.
  //
  // That stopped working the moment apps got their own uid: the repo is owned
  // by whoever checked it out, the app is uid 10000, and a real Linux bind
  // mount preserves that — so the write is a plain EACCES. Docker Desktop
  // virtualizes bind-mount ownership, which is why this only ever failed on
  // Linux CI. The fix is the layout `berth dev` already uses: the root stays
  // read-only (REMEDIATION.md 1.6) and app data goes to the shared
  // dev-workspace directory, which entrypoint.sh chgrp's to the `berth` group
  // precisely so a non-root app can write it.
  const { bindMount, extraBinds, workingDir, workspaceRoot } = resolveDevBindMount(FILESYSTEM_APP_DIR, [
    { appDir: CODE_EDITOR_APP_DIR, relPath: "apps/code-editor" },
  ]);
  // Each app's .berth is a named volume, exactly as dev.ts adds them — without
  // it, generate-capability-policy.js hits EROFS on the read-only mount and
  // the app fails much later for a reason that looks nothing like a mount.
  for (const relPath of ["apps/filesystem", "apps/code-editor"]) {
    const volume = `berth-multi-app-milestone-${relPath.split("/")[1]}-app-state`;
    await docker.createVolume({ Name: volume }).catch(() => {});
    extraBinds.push(`${volume}:/workspace/${relPath}/.berth`);
  }

  console.log("Starting a real multi-app sandbox (filesystem + code-editor)...");
  const running = await startContainer({
    image: "berth/filesystem:dev",
    name: "berth-multi-app-milestone",
    manifest: filesystemManifest,
    bindMount,
    extraBinds,
    workingDir,
    env: { BERTH_WORKSPACE_ROOT: workspaceRoot },
    apps,
    docker,
  });

  const containerLog = await startLogCapture(running.container);

  try {
    await waitFor(() => /multi-app mode: filesystem code-editor/.test(containerLog.text()), 10000, "multi-app mode banner");
    await waitFor(() => /"filesystem" ready/.test(containerLog.text()), 20000, "filesystem runtime ready");
    await waitFor(() => /"code-editor" ready/.test(containerLog.text()), 20000, "code-editor runtime ready");

    const statusLines = [...containerLog.text().matchAll(/\[agent-init\] landlock restrict_self\(\).*$/gm)].map((m) => m[0]);
    console.log("agent-init status lines:", statusLines);
    assert(
      statusLines.length === 2,
      `expected 2 separate agent-init restrict_self() status lines (one per app), got ${statusLines.length}: ${JSON.stringify(statusLines)}`,
    );

    // No app in multi-app mode reads the container's raw stdin (see
    // entrypoint.sh) — the primary is reached the exact same way as any
    // companion, via the relay, not container.attach().
    console.log("\n--- Reaching the PRIMARY app (filesystem) via the docker-exec RPC relay ---");
    const writeResp = await invokeAppExport(running.container, "filesystem", {
      id: "1",
      export: "write_file",
      input: { path: "multi-app-test.txt", content: "hi" },
    });
    assert(!writeResp.error, `filesystem write_file via relay failed: ${writeResp.error}`);

    console.log("\n--- Reaching the COMPANION app (code-editor) via the same RPC relay ---");
    const relayResp = await invokeAppExport(running.container, "code-editor", {
      id: "1",
      export: "open_file",
      input: { path: "multi-app-test.txt" },
    });
    console.log("relay response:", relayResp);
    assert(!relayResp.error, `code-editor open_file via relay failed: ${relayResp.error}`);
    assert(relayResp.result?.content === "hi", `expected code-editor to read back what filesystem wrote, got: ${JSON.stringify(relayResp.result)}`);

    console.log("\nPASS — both apps got their own independent agent-init/Landlock process, and both are reachable via the RPC relay.");
  } finally {
    await containerLog.stop();
    await stopContainer(running.container);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

async function waitFor(predicate, timeoutMs, description) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for: ${description}. Log so far:\n${description}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nMULTI-APP MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
