#!/usr/bin/env node
// Real, running verification of Crew.withManager(): a manager agent
// delegates a multi-step task across two worker agents, each backed by a
// different resident app's tools. Requires ANTHROPIC_API_KEY — skips (not
// fails) if absent.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Computer, Agent, Crew, createAnthropicProvider } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const CODE_EDITOR_APP_DIR = join(REPO_ROOT, "apps", "code-editor");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("SKIP — set ANTHROPIC_API_KEY to run this milestone test.");
    return;
  }

  console.log("Booting one Computer with both apps loaded...");
  const computer = await Computer.boot({ apps: [FILESYSTEM_APP_DIR, CODE_EDITOR_APP_DIR] });

  try {
    const writerTools = computer.tools.filter((t) => t.name.startsWith("filesystem__"));
    const readerTools = computer.tools.filter((t) => t.name.startsWith("code-editor__"));

    const writer = new Agent({
      name: "writer",
      systemPrompt: "You write files when asked. Use your filesystem__write_file tool.",
      llm: createAnthropicProvider(),
      tools: writerTools,
    });
    const reader = new Agent({
      name: "reader",
      systemPrompt: "You open and report the contents of files when asked. Use your code-editor__open_file tool.",
      llm: createAnthropicProvider(),
      tools: readerTools,
    });
    const manager = new Agent({
      name: "manager",
      systemPrompt:
        "You coordinate a writer agent and a reader agent to complete file-based tasks. Delegate to them — don't try to do their jobs yourself.",
      llm: createAnthropicProvider(),
      tools: [],
    });

    const crew = Crew.withManager({ manager, workers: [writer, reader] });

    const output = await crew.run(
      'Have the writer agent create a file named "crew-manager-test.txt" containing exactly "hello from the crew", then have the reader agent open it and report back exactly what it contains.',
    );

    console.log("crew output:", output);
    assert(/hello from the crew/i.test(output), `expected the crew's final answer to report the file's real contents, got: ${output}`);

    console.log("\nPASS — a manager agent delegated a real multi-step task across two worker agents backed by different resident apps.");
  } finally {
    await computer.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nCREW MANAGER MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
