#!/usr/bin/env node
// Real, running verification that Computer.boot() namespaces tool names
// across multiple apps and both remain independently callable — the
// filesystem + code-editor pairing already proven at the docker-orchestrator
// layer (see packages/docker-orchestrator/test/multi-app-milestone.mjs).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Computer } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const CODE_EDITOR_APP_DIR = join(REPO_ROOT, "apps", "code-editor");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log("Booting a Computer with apps/filesystem + apps/code-editor...");
  const computer = await Computer.boot({ apps: [FILESYSTEM_APP_DIR, CODE_EDITOR_APP_DIR] });

  try {
    const toolNames = computer.tools.map((t) => t.name).sort();
    console.log("tools:", toolNames);
    assert(toolNames.includes("filesystem__write_file"), `expected namespaced "filesystem__write_file", got: ${JSON.stringify(toolNames)}`);
    assert(toolNames.includes("code-editor__open_file"), `expected namespaced "code-editor__open_file", got: ${JSON.stringify(toolNames)}`);

    console.log("Writing via the filesystem app's namespaced tool...");
    await computer.call("filesystem__write_file", { path: "multi-app-computer-test.txt", content: "hi from computer" });

    console.log("Reading via the code-editor app's namespaced tool...");
    const result = await computer.call("code-editor__open_file", { path: "multi-app-computer-test.txt" });
    console.log("open_file result:", result);
    assert(
      result.content === "hi from computer",
      `expected code-editor to read back what filesystem wrote, got: ${JSON.stringify(result)}`,
    );

    console.log("\nPASS — both apps' exports are independently callable as namespaced tools on one Computer.");
  } finally {
    await computer.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nCOMPUTER MULTI-APP MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
