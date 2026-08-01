#!/usr/bin/env node
// Real, running verification that the LLMProvider seam is genuinely
// swappable: the same Computer's tools, driven once by
// createAnthropicProvider() and once by createOpenAIProvider(), both
// complete a real tool-calling task. Requires ANTHROPIC_API_KEY and
// OPENAI_API_KEY — skips (not fails) if either is absent, since this needs
// live LLM API credentials rather than just a Docker daemon.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Computer, Agent, createAnthropicProvider, createOpenAIProvider } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY) {
    console.log("SKIP — set ANTHROPIC_API_KEY and OPENAI_API_KEY to run this milestone test.");
    return;
  }

  console.log("Booting one Computer, shared by both providers...");
  const computer = await Computer.boot({ apps: [FILESYSTEM_APP_DIR] });

  try {
    const providers = [
      ["anthropic", createAnthropicProvider],
      ["openai", createOpenAIProvider],
    ];

    for (const [providerName, makeProvider] of providers) {
      console.log(`\n--- Running the same task via ${providerName} ---`);
      const agent = new Agent({
        name: `provider-swap-${providerName}`,
        systemPrompt: "You are a helpful assistant with access to a real filesystem tool. Use it when asked to write or read files.",
        llm: makeProvider(),
        tools: computer.tools,
      });

      const result = await agent.run(
        `Write a file named "provider-swap-${providerName}.txt" with the exact content "hello from ${providerName}", then read it back and tell me what it says.`,
      );

      console.log(`${providerName} final text:`, result.text);
      console.log(
        `${providerName} tool calls:`,
        result.toolCalls.map((c) => c.name),
      );
      assert(result.toolCalls.length > 0, `expected ${providerName} to make at least one tool call`);
      assert(
        result.toolCalls.some((c) => c.name === "write_file") && result.toolCalls.some((c) => c.name === "read_file"),
        `expected ${providerName} to call both write_file and read_file, got: ${JSON.stringify(result.toolCalls.map((c) => c.name))}`,
      );
    }

    console.log("\nPASS — both providers drove the same Computer's tools to a real, completed tool-calling task.");
  } finally {
    await computer.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nPROVIDER SWAP MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
