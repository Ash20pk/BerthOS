#!/usr/bin/env node
// An interactive chat REPL against a real Computer: one container running
// apps/filesystem + examples/notes, one Agent (multi-turn via agent.chat(),
// not the stateless single-shot agent.run() the other examples use) driven
// by OpenAI. Two ways to watch the agent actually use the OS while you chat:
//   - every tool call it makes is printed live via the onToolCall hook
//   - the container's own stdout/stderr is tailed in the background,
//     prefixed "[sandbox]" — the same raw log stream `berth logs` attaches to
// Requires OPENAI_API_KEY — skips (not fails) if absent.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import Docker from "dockerode";
import { streamLogs } from "@berth/docker-orchestrator";
import { createAgent, createOpenAIProvider } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const NOTES_APP_DIR = join(REPO_ROOT, "examples", "notes");

async function tailSandboxLogs(containerName) {
  const docker = new Docker();
  const container = docker.getContainer(containerName);
  try {
    for await (const chunk of streamLogs(container)) {
      for (const line of chunk.split("\n")) {
        if (line.trim()) console.log(`[sandbox] ${line}`);
      }
    }
  } catch {
    // Stream dies when the container stops — expected on exit, nothing to report.
  }
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.log("SKIP — set OPENAI_API_KEY to run this example.");
    return;
  }

  console.log("Booting a Computer with apps/filesystem + examples/notes loaded...");
  const { agent, computer } = await createAgent({
    apps: [FILESYSTEM_APP_DIR, NOTES_APP_DIR],
    llm: createOpenAIProvider(),
    systemPrompt:
      "You are a helpful assistant with access to a real sandboxed filesystem (filesystem__write_file / filesystem__read_file) and a notes list (notes__add_note / notes__list_notes / notes__complete_note). Use your tools when asked to do something that needs them.",
    onToolCall: ({ name, input, result }) => {
      console.log(`[tool] ${name}(${JSON.stringify(input)}) -> ${JSON.stringify(result)}`);
    },
  });

  tailSandboxLogs(computer.containerName); // fire-and-forget, dies with the container

  console.log(`\ncontainer: ${computer.containerName}`);
  console.log("Type a message and press enter. Try: \"write a file called todo.txt with three tasks, then read it back\"");
  console.log("Type /exit to quit.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const line = await rl.question("you> ");
      const input = line.trim();
      if (!input) continue;
      if (input === "/exit" || input === "/quit") break;

      const result = await agent.chat(input);
      console.log(`agent> ${result.text}\n`);
    }
  } finally {
    rl.close();
    console.log("\nStopping the computer...");
    await computer.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
