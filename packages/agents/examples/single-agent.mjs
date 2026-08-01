#!/usr/bin/env node
// The smallest possible computer -> agent -> tool loop: one Computer booted
// from a single resident app (apps/filesystem), one Agent driven by
// OpenAI, no multi-agent composition. Start here before manager-crew.mjs
// or networked-crew.mjs. Requires OPENAI_API_KEY — skips (not fails) if
// absent, same convention as ../test/*-milestone.mjs.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createAgent, createOpenAIProvider } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.log("SKIP — set OPENAI_API_KEY to run this example.");
    return;
  }

  console.log("Booting a Computer with apps/filesystem loaded...");
  const { agent, computer } = await createAgent({
    apps: [FILESYSTEM_APP_DIR],
    llm: createOpenAIProvider(),
    systemPrompt: "You are a helpful assistant with access to a real sandboxed filesystem.",
  });

  try {
    console.log("Running: write hello.txt, then read it back...");
    const result = await agent.run("Write a file called hello.txt containing the text 'hi from @berth/agents', then read it back to me.");

    console.log("\nagent said:", result.text);
    console.log(
      "tool calls made:",
      result.toolCalls.map((c) => c.name),
    );
  } finally {
    await computer.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
