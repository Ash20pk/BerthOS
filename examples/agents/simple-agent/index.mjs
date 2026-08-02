#!/usr/bin/env node
// computer -> agent -> tool, the dead-simple version: one call boots a
// Computer from a single resident app (apps/filesystem), runs one task
// against it, and cleans up. `llm` isn't even passed here, since
// runAgent()/createAgent() auto-detect whichever of ANTHROPIC_API_KEY /
// OPENAI_API_KEY is set in the environment. See index-manual.mjs for the
// fuller form (explicit LLMProvider, kept Agent/Computer handles for more
// than one turn) and ../../../docs/berth-os-reference.md for how to skip
// paying this boot cost on every run via `berth os up` + `connect`.
//
// Unlike packages/agents/examples/*.mjs (which import "../dist/index.js",
// a relative path into @berth/agents' own build output, since those scripts
// live inside that package), this example imports "@berth/agents" by name.
// package.json declares it as a real ("workspace:*") dependency, resolved
// through node_modules the same way any external consumer of Berth would
// get it. Requires ANTHROPIC_API_KEY or OPENAI_API_KEY, and skips (doesn't
// fail) if neither is set.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runAgent } from "@berth/agents";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");

async function main() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    console.log("SKIP: set ANTHROPIC_API_KEY or OPENAI_API_KEY to run this example.");
    return;
  }

  console.log("Booting a Computer with apps/filesystem loaded, running one task, cleaning up...");
  const result = await runAgent({
    apps: FILESYSTEM_APP_DIR,
    systemPrompt: "You are a helpful assistant with access to a real sandboxed filesystem.",
    task: "Write a file called hello.txt containing the text 'hi from @berth/agents', then read it back to me.",
  });

  console.log("\nagent said:", result.text);
  console.log(
    "tool calls made:",
    result.toolCalls.map((c) => c.name),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
