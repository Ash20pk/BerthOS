#!/usr/bin/env node
// Real, running verification of the Phase 2 milestone: "3 first-party apps
// communicating via context bus" — specifically, that code-editor reacts to
// filesystem's fs.file_created publish without ever being told directly to
// open that file.
//
// This boots ONE sandbox (one container) for filesystem — since it's a
// pnpm workspace member, `bindMount`ing the whole workspace root is what
// makes code-editor's own dist/node_modules reachable at the same relative
// path inside the container too (see @berth/cli's resolveDevBindMount). We
// then start code-editor's runtime as a second process in that SAME
// container via `docker exec`, sharing the one context-bus daemon socket
// and /workspace filesystem — this is what "multiple resident apps on one
// agent's computer" means per the PRD, which Phase 1's one-app-per-container
// dev/test/deploy commands don't individually exercise.
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const CODE_EDITOR_ENTRY = "/workspace/apps/code-editor/dist/index.js";
const CODE_EDITOR_MANIFEST = "/workspace/apps/code-editor/berth.yml";
const CODE_EDITOR_RUNTIME = "/workspace/apps/code-editor/node_modules/@berth/sdk/dist/runtime.js";

const docker = new Docker();

async function main() {
  const manifest = await loadManifest(join(FILESYSTEM_APP_DIR, "berth.yml"));

  console.log("Building filesystem's dev image...");
  await buildImage({ appDir: FILESYSTEM_APP_DIR, tag: "berth/filesystem:dev", target: "dev", docker });

  console.log("Starting filesystem's sandbox (workspace root bind-mounted, so code-editor's dist is reachable too)...");
  const running = await startContainer({
    image: "berth/filesystem:dev",
    name: "berth-milestone-filesystem",
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: "/workspace/apps/filesystem",
    // Where `berth dev` puts app data, and where this test's notes.txt has to
    // go now that apps run as their own uid rather than root (Step 2 of
    // docs/per-app-uid-design.md). The bind-mounted repository root is owned
    // by the developer or the CI runner, so a uid-10000 app cannot write it —
    // Blocker 1's stated cost. It never should have: writing into the repo
    // root is the behaviour REMEDIATION.md 1.6 removed from `berth dev`, and
    // the litter it left behind was a symptom of it.
    env: { BERTH_WORKSPACE_ROOT: "/workspace/.berth/dev-workspace" },
    docker,
  });

  const containerLog = await startLogCapture(running.container);

  try {
    console.log("Waiting for filesystem's runtime + context-bus daemon...");
    await waitFor(() => /"filesystem" ready/.test(containerLog.text()), 20000, "filesystem runtime ready");

    console.log("Starting code-editor's runtime as a second process in the same sandbox (docker exec)...");
    const codeEditorOutput = await startCodeEditorExec(running.container);
    await waitFor(() => /"code-editor" ready/.test(codeEditorOutput.text()), 10000, "code-editor to boot");
    await waitFor(
      () => /subscribed to "fs\.file_created"/.test(containerLog.text()),
      10000,
      "code-editor to subscribe (per daemon log)",
    );
    console.log("code-editor is up and subscribed to fs.file_created.");

    console.log("Invoking filesystem's write_file export over its live stdio RPC interface...");
    const response = await invokeExportViaAttach(running.container, {
      id: "1",
      export: "write_file",
      input: { path: "notes.txt", content: "hello from the context-bus milestone test" },
    });
    console.log("write_file RPC response:", response);
    if (response.error) throw new Error(`write_file failed: ${response.error}`);

    console.log("Waiting for code-editor to reactively open notes.txt (no direct invocation)...");
    await waitFor(
      () => /reactively opened "notes\.txt".*after fs\.file_created from "filesystem"/.test(codeEditorOutput.text()),
      8000,
      "code-editor's reactive log line",
    );

    console.log("\nPASS — code-editor reacted to filesystem's publish with zero explicit orchestration.");
    console.log("code-editor output:\n" + codeEditorOutput.text());
  } finally {
    await containerLog.stop();
    await stopContainer(running.container);
  }
}

async function startLogCapture(container) {
  const raw = await container.logs({ follow: true, stdout: true, stderr: true, tail: 0 });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(raw, stdout, stderr);

  let buffer = "";
  stdout.on("data", (chunk) => (buffer += chunk.toString("utf-8")));
  stderr.on("data", (chunk) => (buffer += chunk.toString("utf-8")));

  return {
    text: () => buffer,
    stop: async () => raw.destroy(),
  };
}

async function startCodeEditorExec(container) {
  const exec = await container.exec({
    Cmd: ["node", CODE_EDITOR_RUNTIME],
    Env: [`BERTH_MANIFEST_PATH=${CODE_EDITOR_MANIFEST}`, `BERTH_APP_ENTRY=${CODE_EDITOR_ENTRY}`],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);

  let buffer = "";
  stdout.on("data", (chunk) => (buffer += chunk.toString("utf-8")));
  stderr.on("data", (chunk) => (buffer += chunk.toString("utf-8")));

  return { text: () => buffer };
}

async function invokeExportViaAttach(container, request) {
  const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
  // Terminates the attach options object docker-modem sends as this POST's
  // body straight into the container's stdin, so it can't concatenate onto the
  // first real request — see @berth/docker-orchestrator's stdio-rpc.ts for the
  // full explanation.
  stream.write("\n");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for RPC response")), 5000);
    let buffer = "";

    stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === request.id) {
            clearTimeout(timer);
            stream.end();
            resolve(parsed);
            return;
          }
        } catch {
          // not a complete/JSON line yet — keep buffering
        }
      }
    });
    stream.on("error", reject);
    stream.write(JSON.stringify(request) + "\n");
  });
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
    console.error("\nMILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
