#!/usr/bin/env node
// Exposes an Agent over HTTP via @berth/agents' serveAgent() — the
// framework primitive this example's own server.mjs used to hand-roll
// (GET /health, POST /task) before serveAgent()/createAgentRequestHandler()
// existed (see gaps.md gap #22). serveAgent() also adds POST /chat, a
// Vercel AI SDK `useChat`-compatible streaming endpoint, for free.
//
// The Computer boots (or connects) once at server startup, not per request.
// An HTTP server that rebuilt a container on every POST would make the
// cold-start problem worse, not solve it. Pass BERTH_OS_CONNECT=<name> to
// attach to an already-running `berth os up <name>` instance instead of
// booting a fresh one, the natural pairing for a long-lived server
// process. See ../../../docs/berth-os-reference.md.
//
// Requires ANTHROPIC_API_KEY or OPENAI_API_KEY (createAgent() auto-detects
// whichever is set), and skips (doesn't fail) if neither is present.
import { createAgent, serveAgent } from "@berth/agents";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");

const PORT = Number(process.env.PORT ?? 8787);
const CONNECT = process.env.BERTH_OS_CONNECT;

async function main() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    console.log("SKIP: set ANTHROPIC_API_KEY or OPENAI_API_KEY to run this example.");
    return;
  }

  console.log(CONNECT ? `Connecting to "${CONNECT}"...` : "Booting a Computer with apps/filesystem loaded...");
  const { agent, computer } = await createAgent({
    ...(CONNECT ? { connect: CONNECT } : { apps: FILESYSTEM_APP_DIR }),
    systemPrompt: "You are a helpful assistant with access to a real sandboxed filesystem.",
  });

  const { close } = serveAgent(agent, {
    port: PORT,
    onListening: (port) => {
      console.log(`Agent server listening on http://localhost:${port}`);
      console.log(`  curl http://localhost:${port}/health`);
      console.log(
        `  curl -X POST http://localhost:${port}/task -H 'content-type: application/json' -d '{"task":"write a file called hello.txt with the text hi, then read it back"}'`,
      );
      console.log(`  POST http://localhost:${port}/chat  { messages: UIMessage[] } — a Vercel AI SDK useChat-compatible endpoint`);
    },
  });

  const shutdown = async () => {
    console.log("\nShutting down...");
    await close();
    await computer.stop(); // no-op if BERTH_OS_CONNECT was used, see docs/berth-os-reference.md
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
