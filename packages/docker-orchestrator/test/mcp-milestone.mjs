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
// Scoped to its own data directory and nothing else — so a write aimed at a
// sibling's directory is a denial the manifest *could* grant, which is the
// case where the bridge has an actual fix line to name.
const BOUNDARY_APP_DIR = join(__dirname, "fixtures", "boundary-app-a");
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
      // StdioClientTransport passes a *sanitized* env by default, which drops
      // DOCKER_HOST — so without this the bridge reaches a different daemon
      // than this test just booted the container on, finds nothing there, and
      // boots a second sandbox of its own. Same trap a user hits configuring
      // an MCP client on a Colima host (docs/mac-enforcement.md).
      env: { ...process.env },
    });
    client = new Client({ name: "mcp-milestone-test-client", version: "0.0.0" });
    const connecting = client.connect(transport);
    // Attached mid-connect on purpose: `stderr` only exists once the transport
    // has spawned the child, and waiting for connect() to resolve would miss
    // every line the bridge prints while booting — including the ones that
    // explain a connect() that never resolves.
    await new Promise((resolve) => setImmediate(resolve));
    // The bridge's own diagnostics (boot progress, which container it reached,
    // and what agent-init said about enforcement) go to stderr, because its
    // stdout is the MCP transport. Surfacing them makes a failure here
    // debuggable without re-running by hand.
    transport.stderr?.on("data", (chunk) => process.stderr.write(`[bridge] ${chunk}`));
    await connecting;

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

    console.log("\n--- Test 3: a denied tool call comes back as an explanation, not a bare errno ---");
    // Traversal, not a bare "/etc/..." path, because write_file joins onto
    // BERTH_WORKSPACE_ROOT itself — the point is that the *resulting* path is
    // refused, not that the app validated its input.
    const denied = await client.callTool({
      name: "write_file",
      arguments: { path: "../../../etc/berth-should-not-exist.txt", content: "if you can read this, enforcement failed" },
    });
    const deniedText = (denied.content ?? []).map((c) => c.text ?? "").join("\n");
    console.log("denied tool call returned:\n" + deniedText);
    assert(denied.isError, `expected the out-of-scope write to be refused, got: ${JSON.stringify(denied)}`);
    assert(/BERTH CAPABILITY DENIAL/.test(deniedText), `expected an explained capability denial, got: ${JSON.stringify(deniedText)}`);
    assert(/^denied-by: /m.test(deniedText), `expected the denial to attribute itself (kernel / not-enforced / unknown), got: ${JSON.stringify(deniedText)}`);
    assert(
      /berth\.yml/.test(deniedText),
      `expected the denial to point the reader at the manifest, got: ${JSON.stringify(deniedText)}`,
    );
    // /etc is outside every prefix a filesystem scope may name, so there is no
    // manifest line that would grant it — printing one would be a fix that the
    // schema rejects.
    assert(
      !/filesystem:write:\/etc/.test(deniedText),
      `the denial must not suggest a capability line the manifest schema rejects, got: ${JSON.stringify(deniedText)}`,
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

  await verifyAutoBoot();
  await verifyFixLine();
}

/**
 * `berth mcp` as an MCP client actually invokes it: one command, no container
 * running, nothing started by hand. An MCP client spawns a single process and
 * has nowhere to put a second "run `berth dev` first" step, so this is the
 * path the documented 5-minute setup depends on.
 */
async function verifyAutoBoot() {
  const containerName = "berth-mcp-autoboot-filesystem";
  await stopContainer(docker.getContainer(containerName)).catch(() => {});

  console.log(`\n--- Test 4: \`berth mcp\` boots its own sandbox when none is running (${containerName}) ---`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BERTH_BIN, "mcp", "--app=filesystem", `--app-dir=${FILESYSTEM_APP_DIR}`, `--container=${containerName}`],
    stderr: "pipe",
    // Without this the bridge would boot its sandbox on whichever daemon the
    // sanitized default env points at, not the one this test then inspects —
    // StdioClientTransport drops DOCKER_HOST. Same trap a user hits
    // configuring an MCP client on a Colima host (docs/mac-enforcement.md).
    env: { ...process.env },
  });
  const client = new Client({ name: "mcp-milestone-autoboot-client", version: "0.0.0" });
  let stderr = "";
  try {
    // Generous, because this path builds the dev image if it isn't cached —
    // the same reason the docs tell a human to warm the build once before
    // pointing an MCP client at it.
    await client.connect(transport, { timeout: 600000 });
    transport.stderr?.on("data", (chunk) => (stderr += chunk.toString("utf-8")));

    const result = await client.callTool({
      name: "write_file",
      arguments: { path: "mcp-autoboot.txt", content: "written through a bridge that booted its own sandbox" },
    }, undefined, { timeout: 120000 });
    assert(!result.isError, `expected the auto-booted bridge's write to succeed, got: ${JSON.stringify(result)} (stderr: ${stderr})`);

    const container = docker.getContainer(containerName);
    const state = await container.inspect();
    assert(state.State.Running, `expected the auto-booted container to be running, got: ${JSON.stringify(state.State)}`);

    const catOutput = await execInContainer(container, ["cat", "/workspace/.berth/dev-workspace/mcp-autoboot.txt"]);
    assert(
      catOutput.includes("booted its own sandbox"),
      `expected the auto-booted container to hold the file the bridge wrote, got: ${JSON.stringify(catOutput)}`,
    );
    console.log("PASS — one command, no pre-started container, and the tool call reached a real sandbox.");
  } finally {
    await client.close().catch(() => {});
    // The bridge stops what it booted on SIGTERM; this is the belt-and-braces
    // version, since a leaked container would break the next run.
    await stopContainer(docker.getContainer(containerName)).catch(() => {});
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

/**
 * The other half of Test 3. /etc is outside every prefix a filesystem scope may
 * name, so the honest answer there is "no manifest line grants this" — which
 * proves the bridge does not invent a fix, but not that it can name a real one.
 * boundary-app-a is scoped to its own data directory only, so a write into a
 * sibling's directory is precisely a denial one declared line would allow.
 */
async function verifyFixLine() {
  const containerName = "berth-mcp-fixline-boundary-app-a";
  await stopContainer(docker.getContainer(containerName)).catch(() => {});

  console.log(`\n--- Test 5: a grantable denial names the exact berth.yml line (${containerName}) ---`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BERTH_BIN, "mcp", "--app=boundary-app-a", `--app-dir=${BOUNDARY_APP_DIR}`, `--container=${containerName}`],
    stderr: "pipe",
    env: { ...process.env },
  });
  const client = new Client({ name: "mcp-milestone-fixline-client", version: "0.0.0" });
  try {
    await client.connect(transport, { timeout: 600000 });
    const denied = await client.callTool(
      { name: "write_file", arguments: { path: "../boundary-app-b/denied-via-mcp.txt", content: "should not land" } },
      undefined,
      { timeout: 120000 },
    );
    const text = (denied.content ?? []).map((c) => c.text ?? "").join("\n");
    console.log("denied tool call returned:\n" + text);
    assert(denied.isError, `expected the cross-app write to be refused, got: ${JSON.stringify(denied)}`);
    assert(
      /- filesystem:write:\/workspace\/\.berth\/dev-workspace\/boundary-app-b/.test(text),
      `expected the denial to name the exact capability line that would grant it, got: ${JSON.stringify(text)}`,
    );
    assert(/berth\.yml/.test(text), `expected the denial to name the file to edit, got: ${JSON.stringify(text)}`);
    assert(
      /cannot be widened on a running process/.test(text),
      `expected the denial to say the fix needs a restart, got: ${JSON.stringify(text)}`,
    );
    console.log("PASS — the denial an agent reads over MCP names the file, the line, and the restart.");
  } finally {
    await client.close().catch(() => {});
    await stopContainer(docker.getContainer(containerName)).catch(() => {});
  }
}
