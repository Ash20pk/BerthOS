#!/usr/bin/env node
// Real, running verification that @berth/agents' own createMcpClientTools()
// (not just the underlying SDK, already proven by
// packages/docker-orchestrator/test/mcp-milestone.mjs) turns a real running
// MCP server's tools into real Tools an Agent can call — boots a real
// apps/filesystem dev container, spawns the actual `berth mcp --app=filesystem`
// CLI as a child process (stdio transport), and drives a real Agent (a
// scripted fake LLMProvider, no API key needed) that calls the resulting
// MCP-backed "write_file" tool, then confirms the write landed in the real
// container by reading it back directly (bypassing the bridge entirely).
import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer } from "@berth/docker-orchestrator";
import { Agent, createMcpClientTools } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const BERTH_BIN = join(REPO_ROOT, "packages", "cli", "bin", "berth.js");

const docker = new Docker();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** No API key needed: scripts a single tool call then a final answer, same ScriptedLLM shape agent.test.ts's fakes use. */
function scriptedLlm(toolCallArgs) {
  let turn = 0;
  return {
    name: "fake",
    async chat({ tools }) {
      turn++;
      if (turn === 1) {
        const tool = tools.find((t) => t.name === "write_file");
        assert(tool, `expected an MCP-backed "write_file" tool, got: ${tools.map((t) => t.name).join(", ")}`);
        return { toolCalls: [{ id: "1", name: "write_file", input: toolCallArgs }], stop: false };
      }
      return { text: "done", toolCalls: [], stop: true };
    },
  };
}

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
    docker,
  });

  const containerLog = await startLogCapture(running.container);
  let mcp;
  try {
    await waitFor(() => /"filesystem" ready/.test(containerLog.text()), 20000, "filesystem runtime ready");

    console.log("\n--- createMcpClientTools() against a real `berth mcp --app=filesystem` subprocess ---");
    mcp = await createMcpClientTools({
      transport: { command: process.execPath, args: [BERTH_BIN, "mcp", "--app=filesystem", `--app-dir=${FILESYSTEM_APP_DIR}`] },
    });
    console.log("tools:", mcp.tools.map((t) => t.name));

    console.log("\n--- A real Agent calls the MCP-backed write_file tool ---");
    const agent = new Agent({
      llm: scriptedLlm({ path: "mcp-client-milestone.txt", content: "written via createMcpClientTools()" }),
      tools: mcp.tools,
    });
    const result = await agent.run("write a file for me");
    assert(result.text === "done", `expected the agent to reach its final answer, got: ${JSON.stringify(result)}`);
    assert(result.toolCalls.length === 1 && !result.toolCalls[0].result?.error, `expected the tool call to succeed, got: ${JSON.stringify(result.toolCalls)}`);

    const catOutput = await execInContainer(running.container, ["cat", "/workspace/mcp-client-milestone.txt"]);
    console.log("file contents seen via docker exec:", JSON.stringify(catOutput));
    assert(
      catOutput.includes("written via createMcpClientTools()"),
      `expected the Agent's MCP tool call to have really written the file, got: ${JSON.stringify(catOutput)}`,
    );

    console.log(
      "\nPASS — createMcpClientTools() turned a real running MCP server into real Tools, and a real Agent used one " +
        "to reach the actual container, not a mock of either side.",
    );
  } finally {
    await mcp?.close();
    await containerLog.stop();
    await stopContainer(running.container);
  }
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
    console.error("\nMCP CLIENT MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
