#!/usr/bin/env node
// Multi-agent composition, in-process: one Computer loaded with two resident
// apps (apps/filesystem and examples/notes), one worker Agent per app, and a
// manager Agent that delegates via Crew.withManager() — the "agent-as-tool"
// pattern (Agent.asTool()). Requires OPENAI_API_KEY — skips (not fails)
// if absent.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Computer, Agent, Crew, createOpenAIProvider } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");
const NOTES_APP_DIR = join(REPO_ROOT, "examples", "notes");

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.log("SKIP — set OPENAI_API_KEY to run this example.");
    return;
  }

  console.log("Booting one Computer with both apps/filesystem and examples/notes loaded...");
  const computer = await Computer.boot({ apps: [FILESYSTEM_APP_DIR, NOTES_APP_DIR] });

  try {
    const fileTools = computer.tools.filter((t) => t.name.startsWith("filesystem__"));
    const noteTools = computer.tools.filter((t) => t.name.startsWith("notes__"));

    const filer = new Agent({
      name: "filer",
      systemPrompt: "You read and write files. Use your filesystem__write_file / filesystem__read_file tools.",
      llm: createOpenAIProvider(),
      tools: fileTools,
    });
    const notetaker = new Agent({
      name: "notetaker",
      systemPrompt: "You keep a list of notes. Use your notes__add_note / notes__list_notes tools.",
      llm: createOpenAIProvider(),
      tools: noteTools,
    });
    const manager = new Agent({
      name: "manager",
      systemPrompt:
        "You coordinate a filer agent and a notetaker agent. Delegate file work to filer and note-taking to notetaker — don't try to do their jobs yourself.",
      llm: createOpenAIProvider(),
      tools: [],
    });

    const crew = Crew.withManager({ manager, workers: [filer, notetaker] });

    console.log("Running a task that needs both agents...");
    const output = await crew.run(
      "Ask the notetaker to add a note that says 'ship the agents examples', then ask the filer to write a file called summary.txt containing that same note text, then confirm both are done.",
    );

    console.log("\ncrew output:", output);
  } finally {
    await computer.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
