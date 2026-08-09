#!/usr/bin/env node
// Real, running verification of the MCP bridge (`berth mcp`,
// packages/cli/src/commands/mcp.ts): boots a real apps/filesystem dev
// container, spawns `berth mcp --app=filesystem` as a real child process,
// and drives it with the actual @modelcontextprotocol/sdk Client over real
// stdio — a genuine MCP tools/list + tools/call round trip, not a mock of
// either side. Confirms the write really happened by reading the file back
// out of the container directly (bypassing the bridge), so this proves the
// bridge's tool call reached the app for real.
import Docker from "dockerode";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer } from "../dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const BERTH_BIN = join(REPO_ROOT, "packages", "cli", "bin", "berth.js");

const docker = new Docker();

async function main() {
  const manifest = await loadManifest(join(FILESYSTEM_APP_DIR, "berth.yml"));

  console.log("Building filesystem's dev image...");
  await buildImage({ appDir: FILESYSTEM_APP_DIR, tag: "berth/filesystem:dev", target: "dev", docker });

  console.log("Starting filesystem's sandbox as berth-dev-filesystem (matches `berth mcp`'s default container naming)...");
  const running = await startContainer({
    image: "berth/filesystem:dev",
    name: "berth-dev-filesystem",
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: "/workspace/apps/filesystem",
    // Where `berth dev` puts app data. Apps run as their own uid now (Step 2
    // of docs/per-app-uid-design.md) and cannot write the bind-mounted
    // repository root, which is owned by the developer or the CI runner.
    env: { BERTH_WORKSPACE_ROOT: "/workspace/.berth/dev-workspace" },
    docker,
  });

  const containerLog = await startLogCapture(running.container);
  let client;
  try {
    await waitFor(() => /"filesystem" ready/.test(containerLog.text()), 20000, "filesystem runtime ready");

    console.log("\n--- Spawning `berth mcp --app=filesystem` and connecting a real MCP client to it ---");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BERTH_BIN, "mcp", "--app=filesystem", `--app-dir=${FILESYSTEM_APP_DIR}`],
      stderr: "pipe",
    });
    client = new Client({ name: "mcp-milestone-test-client", version: "0.0.0" });
    await client.connect(transport);

    console.log("\n--- Test 1: tools/list includes filesystem's declared exports ---");
    const { tools } = await client.listTools();
    console.log("tools:", tools.map((t) => t.name));
    const writeFileTool = tools.find((t) => t.name === "write_file");
    assert(writeFileTool, `expected a "write_file" tool from filesystem's manifest, got: ${tools.map((t) => t.name).join(", ")}`);
    assert(
      writeFileTool.inputSchema?.properties?.path && writeFileTool.inputSchema?.properties?.content,
      `expected write_file's MCP inputSchema to carry path/content fields, got: ${JSON.stringify(writeFileTool.inputSchema)}`,
    );

    console.log("\n--- Test 2: tools/call write_file actually writes inside the real container ---");
    const result = await client.callTool({
      name: "write_file",
      arguments: { path: "mcp-milestone.txt", content: "written via the real MCP bridge" },
    });
    console.log("callTool result:", result);
    assert(!result.isError, `expected the write_file tool call to succeed, got: ${JSON.stringify(result)}`);

    // write_file resolves relative paths against BERTH_WORKSPACE_ROOT
    // (set above), not the app's own working directory.
    const catOutput = await execInContainer(running.container, ["cat", "/workspace/.berth/dev-workspace/mcp-milestone.txt"]);
    console.log("file contents seen via docker exec:", JSON.stringify(catOutput));
    assert(
      catOutput.includes("written via the real MCP bridge"),
      `expected the file the MCP tool call wrote to be readable directly from the container, got: ${JSON.stringify(catOutput)}`,
    );

    console.log(
      "\nPASS — a real @modelcontextprotocol/sdk Client listed filesystem's exports as MCP tools and a real " +
        "tools/call reached the actual running app, whose write is visible outside the bridge entirely.",
    );
  } finally {
    await client?.close();
    await containerLog.stop();
    await stopContainer(running.container);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function execInContainer(container, cmd) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);
  let out = "";
  stdout.on("data", (chunk) => (out += chunk.toString("utf-8")));
  await new Promise((resolve) => stream.on("end", resolve));
  return out;
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
  throw new Error(`timed out waiting for: ${description}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nMCP BRIDGE MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
