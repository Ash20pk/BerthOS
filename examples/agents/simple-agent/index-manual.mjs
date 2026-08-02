#!/usr/bin/env node
// The fuller form of index.mjs: explicit LLMProvider, and the Agent/Computer
// handles kept around instead of runAgent()'s one-call boot+run+cleanup —
// useful once you need more than one turn, want to call tools directly, or
// want to snapshot the Computer before stopping it.
//
// Pass --connect=<name> to attach to an already-running `berth os up <name>`
// instance instead of booting a fresh one (see
// ../../../docs/berth-os-reference.md) — e.g.:
//   berth os up my-agent --apps=<path to apps/filesystem, from repo root>
//   node index-manual.mjs --connect=my-agent
// computer.stop() is always safe to call either way: it's a no-op when
// `connect` was used, so this never tears down a shared OS out from under
// other runs.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createAgent, createAnthropicProvider, createOpenAIProvider } from "@berth/agents";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");

function connectFlag() {
  const flag = process.argv.find((a) => a.startsWith("--connect="));
  return flag ? flag.slice("--connect=".length) : undefined;
}

async function main() {
  const connect = connectFlag();

  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    console.log("SKIP — set ANTHROPIC_API_KEY or OPENAI_API_KEY to run this example.");
    return;
  }
  const llm = process.env.ANTHROPIC_API_KEY ? createAnthropicProvider() : createOpenAIProvider();

  console.log(connect ? `Connecting to "${connect}"...` : "Booting a Computer with apps/filesystem loaded...");
  const { agent, computer } = await createAgent({
    ...(connect ? { connect } : { apps: [FILESYSTEM_APP_DIR] }),
    llm,
    systemPrompt: "You are a helpful assistant with access to a real sandboxed filesystem.",
  });

  try {
    console.log("Running: write hello.txt, then read it back...");
    const result = await agent.run(
      "Write a file called hello.txt containing the text 'hi from @berth/agents', then read it back to me.",
    );

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
