#!/usr/bin/env node
// Multi-agent composition across real network peers: two independently
// booted Computers (each its own container, each running its own
// in-container agent loop via bootNetworkedAgent()'s synthesized
// agent-server companion app), joined to a shared Docker network and
// reachable as Tools by a host-side manager Agent via Crew.networked().
// Requires OPENAI_API_KEY — skips (not fails) if absent. See
// ../../../docs/agents-reference.md for what's real vs. deferred
// about this pattern (host-mediated dispatch, unrestricted egress, etc).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Agent, Crew, createOpenAIProvider, bootNetworkedAgent } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const NOTES_APP_DIR = join(REPO_ROOT, "examples", "notes");

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.log("SKIP — set OPENAI_API_KEY to run this example.");
    return;
  }

  const apiKeyEnv = { OPENAI_API_KEY: process.env.OPENAI_API_KEY };

  console.log("Booting peer 'filer' (its own computer, apps/filesystem tools)...");
  const filer = await bootNetworkedAgent({
    name: "filer",
    apps: [FILESYSTEM_APP_DIR],
    llm: { provider: "openai", apiKeyEnvVar: "OPENAI_API_KEY" },
    systemPrompt: "You write and read files when asked, using your filesystem tools.",
    env: apiKeyEnv,
  });

  console.log("Booting peer 'notetaker' (its own computer, examples/notes tools)...");
  const notetaker = await bootNetworkedAgent({
    name: "notetaker",
    apps: [NOTES_APP_DIR],
    llm: { provider: "openai", apiKeyEnvVar: "OPENAI_API_KEY" },
    systemPrompt: "You keep a list of notes when asked, using your notes tools.",
    env: apiKeyEnv,
  });

  try {
    console.log("peer containers:", filer.computer.containerName, notetaker.computer.containerName);

    const manager = new Agent({
      name: "manager",
      systemPrompt: "You coordinate two independent networked agents, filer and notetaker, delegating tasks to whichever is relevant.",
      llm: createOpenAIProvider(),
      tools: [],
    });

    const crew = Crew.networked({ manager, peers: [filer, notetaker] });

    console.log("Running a task across both networked peers...");
    const output = await crew.run(
      'Ask notetaker to add a note that says "networked crew example ran", then ask filer to write a file named "networked-crew.txt" containing exactly "hello from a networked peer", and report back what each one did.',
    );

    console.log("\ncrew output:", output);
  } finally {
    await filer.stop();
    await notetaker.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
