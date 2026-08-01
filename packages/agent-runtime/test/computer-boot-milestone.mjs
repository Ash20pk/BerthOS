#!/usr/bin/env node
// Real, running verification that Computer.boot() produces a live, callable
// tool list from a single resident app's exports — no mocking of Docker, the
// image build, or the RPC transport.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Computer } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log("Booting a Computer with apps/filesystem...");
  const computer = await Computer.boot({ apps: [FILESYSTEM_APP_DIR] });

  try {
    const toolNames = computer.tools.map((t) => t.name).sort();
    console.log("tools:", toolNames);
    assert(toolNames.includes("write_file"), `expected an unnamespaced "write_file" tool, got: ${JSON.stringify(toolNames)}`);
    assert(toolNames.includes("read_file"), `expected an unnamespaced "read_file" tool, got: ${JSON.stringify(toolNames)}`);

    console.log("Calling write_file...");
    await computer.call("write_file", { path: "computer-boot-test.txt", content: "hello from agent-runtime" });

    console.log("Calling read_file...");
    const result = await computer.call("read_file", { path: "computer-boot-test.txt" });
    console.log("read_file result:", result);
    assert(result.content === "hello from agent-runtime", `expected round-tripped content, got: ${JSON.stringify(result)}`);

    console.log("\nPASS — Computer.boot() produced a live, callable tool list for a single app.");
  } finally {
    await computer.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nCOMPUTER BOOT MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
