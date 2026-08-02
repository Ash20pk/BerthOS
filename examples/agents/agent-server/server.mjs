#!/usr/bin/env node
// Exposes an Agent over HTTP: POST /task { task } -> { text, toolCalls }.
// The agent is the thing being served here — a client (curl, a frontend,
// another service) sends it a task and gets the result back, rather than
// the agent driving something itself.
//
// The Computer boots (or connects) once at server startup, not per request
// — an HTTP server that rebuilt a container on every POST would make the
// cold-start problem worse, not solve it. Pass BERTH_OS_CONNECT=<name> to
// attach to an already-running `berth os up <name>` instance instead of
// booting a fresh one — the natural pairing for a long-lived server
// process. See ../../../docs/berth-os-reference.md.
//
// Requires ANTHROPIC_API_KEY or OPENAI_API_KEY (createAgent() auto-detects
// whichever is set) — skips (not fails) if neither is present.
import { createServer } from "node:http";
import { createAgent } from "@berth/agents";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const FILESYSTEM_APP_DIR = join(REPO_ROOT, "apps", "filesystem");

const PORT = Number(process.env.PORT ?? 8787);
const CONNECT = process.env.BERTH_OS_CONNECT;

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    console.log("SKIP — set ANTHROPIC_API_KEY or OPENAI_API_KEY to run this example.");
    return;
  }

  console.log(CONNECT ? `Connecting to "${CONNECT}"...` : "Booting a Computer with apps/filesystem loaded...");
  const { agent, computer } = await createAgent({
    ...(CONNECT ? { connect: CONNECT } : { apps: FILESYSTEM_APP_DIR }),
    systemPrompt: "You are a helpful assistant with access to a real sandboxed filesystem.",
  });

  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true, tools: agent.tools.map((t) => t.name) });
      return;
    }

    if (req.method === "POST" && req.url === "/task") {
      let task;
      try {
        ({ task } = await readJsonBody(req));
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body — expected { "task": string }' });
        return;
      }
      if (typeof task !== "string" || !task) {
        sendJson(res, 400, { error: '"task" must be a non-empty string' });
        return;
      }

      try {
        const result = await agent.run(task);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    sendJson(res, 404, { error: "not found — POST /task { task: string }, GET /health" });
  });

  server.listen(PORT, () => {
    console.log(`Agent server listening on http://localhost:${PORT}`);
    console.log(`  curl http://localhost:${PORT}/health`);
    console.log(
      `  curl -X POST http://localhost:${PORT}/task -H 'content-type: application/json' -d '{"task":"write a file called hello.txt with the text hi, then read it back"}'`,
    );
  });

  const shutdown = async () => {
    console.log("\nShutting down...");
    server.close();
    await computer.stop(); // no-op if BERTH_OS_CONNECT was used — see docs/berth-os-reference.md
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
