#!/usr/bin/env node
// Real, running verification that @berth/sdk-python's context-bus client
// (context_bus.py, compiled-protobuf framing) genuinely interoperates with
// the Rust daemon and a TypeScript subscriber — not just with itself.
//
// Mirrors context-bus-milestone.mjs's exact original pattern (before real
// multi-app-per-sandbox support existed): ONE container, primary app's own
// entrypoint path boots the context-bus daemon, and a companion app's
// runtime is started as a second process via `docker exec`, sharing the
// same daemon socket and /workspace bind mount. Here the PRIMARY is Python
// (apps/hello-world-py, BERTH_APP_RUNTIME=python) and the COMPANION is
// TypeScript (apps/code-editor) — the reverse language pairing from the
// original Phase 2 test, proving the interop isn't an artifact of one
// specific language being "first."
//
// apps/code-editor already subscribes to "fs.file_created" with a
// {path, createdBy} payload (see its own src/index.ts) — zero changes
// needed there. apps/hello-world-py's publish_file_created export publishes
// to that exact topic/shape.
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const APP_DIR = join(REPO_ROOT, "apps", "hello-world-py");
const CODE_EDITOR_ENTRY = "/workspace/apps/code-editor/dist/index.js";
const CODE_EDITOR_MANIFEST = "/workspace/apps/code-editor/berth.yml";
const CODE_EDITOR_RUNTIME = "/workspace/apps/code-editor/node_modules/@berth/sdk/dist/runtime.js";

const docker = new Docker();

async function main() {
  const manifest = await loadManifest(join(APP_DIR, "berth.yml"));
  await rm(join(APP_DIR, ".berth"), { recursive: true, force: true });

  console.log("--- Building hello-world-py's dev image ---");
  await buildImage({ appDir: APP_DIR, tag: "berth/hello-world-py:dev", target: "dev", docker });

  console.log("\n--- Starting hello-world-py's sandbox (BERTH_APP_RUNTIME=python) ---");
  const running = await startContainer({
    image: "berth/hello-world-py:dev",
    name: "berth-python-context-bus-milestone",
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: "/workspace/apps/hello-world-py",
    env: { BERTH_APP_RUNTIME: "python" },
    docker,
  });

  const containerLog = await startLogCapture(running.container);
  try {
    await waitFor(() => /"hello-world-py" ready/.test(containerLog.text()), 20000, "hello-world-py runtime ready");

    console.log("\n--- Starting code-editor's (TypeScript) runtime as a second process, docker exec ---");
    const codeEditorOutput = await startCodeEditorExec(running.container);
    await waitFor(() => /"code-editor" ready/.test(codeEditorOutput.text()), 10000, "code-editor to boot");
    await waitFor(
      () => /subscribed to "fs\.file_created"/.test(containerLog.text()),
      10000,
      "code-editor to subscribe (per daemon log)",
    );
    console.log("code-editor is up and subscribed to fs.file_created.");

    console.log("\n--- Invoking hello-world-py's publish_file_created export over its real stdio RPC ---");
    const rpc = await createRpcClient(running.container);
    const response = await rpc.call({
      id: "1",
      export: "publish_file_created",
      input: { path: "apps/hello-world-py/berth.yml", created_by: "hello-world-py" },
    });
    console.log("publish_file_created RPC response:", response);
    if (response.error) throw new Error(`publish_file_created failed: ${response.error}`);
    rpc.close();

    console.log("\n--- Waiting for code-editor to reactively open the published file (no direct invocation) ---");
    await waitFor(
      () => /reactively opened "apps\/hello-world-py\/berth\.yml".*after fs\.file_created from "hello-world-py"/.test(codeEditorOutput.text()),
      8000,
      "code-editor's reactive log line",
    );

    console.log(
      "\nPASS — a Python resident app's real context-bus publish (compiled-protobuf framing) reached a real " +
        "TypeScript subscriber through the actual Rust daemon, with zero explicit orchestration between them.",
    );
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

  return { text: () => buffer, stop: async () => raw.destroy() };
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

  let firstWrite = true;
  return {
    call(request) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reject(new Error(`timed out waiting for RPC response to ${JSON.stringify(request)}`));
        }, 30000);
        pending.set(request.id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        // See docs/sdk-python-reference.md's note on the docker-modem
        // attach() bug: its own options object gets sent as a bodyless
        // POST with no trailing newline, which would otherwise concatenate
        // onto this being the first line written to the container's stdin.
        const prefix = firstWrite ? "\n" : "";
        firstWrite = false;
        stream.write(prefix + JSON.stringify(request) + "\n");
      });
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
    console.error("\nPYTHON SDK CONTEXT-BUS MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
