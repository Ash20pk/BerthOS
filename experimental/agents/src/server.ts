import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Agent } from "./agent.js";
import { createInMemorySession, type Session } from "./session.js";
import { abortOnClientDisconnect } from "./cancellation.js";
import { isAbortError } from "./errors.js";
import type { AgentMessage } from "./types.js";

// The exact headers the `ai` package's own UI_MESSAGE_STREAM_HEADERS
// constant sets (checked against a real installed copy of `ai@7.0.52`
// rather than assumed from docs, which don't show `x-accel-buffering` —
// that one matters for real: without it, an nginx reverse proxy in front of
// this server would buffer the whole response before forwarding it,
// silently turning a streaming reply into a non-streaming one).
const UI_MESSAGE_STREAM_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-vercel-ai-ui-message-stream": "v1",
  "x-accel-buffering": "no",
};

/** One `parts[]` entry of an AI SDK `UIMessage` — text only is understood here; anything else (images, file parts, a prior turn's own tool-call/tool-result parts) is dropped when reconstructing prior history, not an error. See docs/agents-reference.md's "what this doesn't do." */
interface UiMessagePart {
  type: string;
  text?: string;
}

interface UiMessage {
  id?: string;
  role: "system" | "user" | "assistant";
  parts: UiMessagePart[];
}

function textOf(message: UiMessage): string {
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/** `system`-role UIMessages are dropped, not mapped — AgentMessage has no "system" role (an Agent's systemPrompt is set once at construction, not per-turn), and threading a per-request system message through would need a bigger API change than this endpoint's scope. */
function uiMessagesToAgentMessages(messages: UiMessage[]): AgentMessage[] {
  return messages
    .filter((m): m is UiMessage & { role: "user" | "assistant" } => m.role !== "system")
    .map((m) => ({ role: m.role, text: textOf(m) }));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface AgentRequestHandlerOptions {
  /**
   * Resolves a Session for a `sessionId` passed to POST /task. Defaults to
   * one createInMemorySession() per distinct sessionId, cached for this
   * handler's lifetime (gone on process restart, and never shared across
   * separate createAgentRequestHandler() calls). Pass your own — e.g.
   * `(id) => createSemanticFsSession(computer, id)` — for durable,
   * cross-restart history. POST /chat never uses this: the AI SDK's
   * useChat sends the client's full message history on every request, so
   * that endpoint builds its own per-request session from the request body
   * instead of needing one persisted server-side.
   */
  sessionFor?: (sessionId: string) => Session;
}

function defaultSessionFor(): (sessionId: string) => Session {
  const sessions = new Map<string, Session>();
  return (sessionId) => {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const created = createInMemorySession();
    sessions.set(sessionId, created);
    return created;
  };
}

/**
 * A plain Node `(req, res) => Promise<void>` request listener exposing an
 * already-constructed Agent over HTTP — the framework primitive
 * `examples/agents/agent-server`'s hand-rolled `server.mjs` was standing in
 * for (gap #22: no agent-facing HTTP surface, unlike ADK's `adk web`/`adk
 * api_server` or AI SDK's own `useChat`). Composable, not a whole server:
 * mount it inside your own `http.createServer()`, or use serveAgent()
 * below for a one-call server that owns its own listen()/close(). Three
 * routes:
 *
 * - `GET /health` -> `{ok: true, tools: string[]}`
 * - `POST /task {task, runId?, sessionId?}` -> `{text, toolCalls}` — the exact shape examples/agents/agent-server's own server.mjs already used, generalized into a reusable primitive rather than a one-off script.
 * - `POST /chat {messages: UIMessage[]}` -> a Vercel AI SDK `useChat`-compatible UI Message Stream (SSE) — verified against a real installed copy of the `ai` package's own `readUIMessageStream()`/`parseJsonEventStream()`, not just written to match documentation. See server.test.ts.
 */
export function createAgentRequestHandler(
  agent: Agent,
  options: AgentRequestHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const sessionFor = options.sessionFor ?? defaultSessionFor();

  return async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true, tools: agent.tools.map((t) => t.name) });
      return;
    }

    if (req.method === "POST" && req.url === "/task") {
      await handleTask(agent, sessionFor, req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/chat") {
      await handleChat(agent, req, res);
      return;
    }

    sendJson(res, 404, { error: "not found: GET /health, POST /task { task }, POST /chat { messages }" });
  };
}

async function handleTask(
  agent: Agent,
  sessionFor: (sessionId: string) => Session,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: { task?: unknown; runId?: unknown; sessionId?: unknown };
  try {
    body = (await readJsonBody(req)) as typeof body;
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body, expected { "task": string }' });
    return;
  }
  if (typeof body.task !== "string" || !body.task) {
    sendJson(res, 400, { error: '"task" must be a non-empty string' });
    return;
  }

  // A client that hangs up mid-run used to leave the run going: nothing here
  // listened for a disconnect, so a closed tab kept driving LLM turns and
  // billing for them with no one left to receive the answer. See
  // REMEDIATION 4.2.
  const disconnect = abortOnClientDisconnect(req);
  try {
    const session = typeof body.sessionId === "string" ? sessionFor(body.sessionId) : undefined;
    const result = await agent.run(body.task, {
      runId: typeof body.runId === "string" ? body.runId : undefined,
      session,
      signal: disconnect.signal,
    });
    sendJson(res, 200, result);
  } catch (err) {
    // Writing to a socket the client already closed throws; there is also
    // nobody to read the status code. Stay quiet rather than turning a
    // routine disconnect into an unhandled error in the server's logs.
    if (isAbortError(err)) return;
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    disconnect.dispose();
  }
}

async function handleChat(agent: Agent, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { messages?: UiMessage[] };
  try {
    body = (await readJsonBody(req)) as typeof body;
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body, expected { "messages": UIMessage[] } (Vercel AI SDK useChat format)' });
    return;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
  if (lastUserIndex === -1) {
    sendJson(res, 400, { error: "no user message found in messages" });
    return;
  }
  const lastUserMessage = messages[lastUserIndex] as UiMessage;
  const input = textOf(lastUserMessage);
  const priorMessages = uiMessagesToAgentMessages(messages.slice(0, lastUserIndex));
  const session = createInMemorySession(priorMessages);

  res.writeHead(200, UI_MESSAGE_STREAM_HEADERS);
  const send = (chunk: Record<string, unknown>) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);

  send({ type: "start" });
  send({ type: "start-step" });
  send({ type: "text-start", id: "0" });

  const disconnect = abortOnClientDisconnect(req);
  try {
    // onText only fires when the resolved LLMProvider implements
    // chatStream (see AgentOptions.trace's own doc comment for the same
    // "absent means no incremental events" contract) — a provider without
    // it means `streamed` stays false and the fallback below sends the
    // whole answer as one chunk instead, rather than silently sending
    // nothing.
    let streamed = false;
    const result = await agent.run(input, {
      session,
      signal: disconnect.signal,
      onText: (delta) => {
        streamed = true;
        send({ type: "text-delta", id: "0", delta });
      },
    });
    if (!streamed && result.text) {
      send({ type: "text-delta", id: "0", delta: result.text });
    }
    send({ type: "text-end", id: "0" });
    send({ type: "finish-step" });
    send({ type: "finish" });
  } catch (err) {
    // A disconnect is the client's own doing, and the stream it would be
    // reported on is the one that just went away.
    if (!isAbortError(err)) {
      send({ type: "error", errorText: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    disconnect.dispose();
    // The [DONE] sentinel is part of the stream contract the `ai` package's
    // client parser reads, so it stays on every path — but only while the
    // socket is still there. Writing to a destroyed one throws, which in a
    // `finally` would replace the real error with an ERR_STREAM_DESTROYED.
    if (!res.destroyed) {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
}

export interface ServeAgentOptions {
  /** Defaults to 8787, matching examples/agents/agent-server's own default. */
  port?: number;
  onListening?: (port: number) => void;
  sessionFor?: (sessionId: string) => Session;
}

export interface AgentServerHandle {
  server: Server;
  close(): Promise<void>;
}

/**
 * The one-call entry point: owns a real http.Server's listen()/close(),
 * exposing an already-constructed Agent over the same three routes
 * createAgentRequestHandler() implements — mirrors runAgent()'s "one call
 * to a working X" positioning, for "serve this agent" instead of "run this
 * one task and tear down."
 */
export function serveAgent(agent: Agent, options: ServeAgentOptions = {}): AgentServerHandle {
  const handler = createAgentRequestHandler(agent, { sessionFor: options.sessionFor });
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });
  const port = options.port ?? 8787;
  server.listen(port, () => options.onListening?.(port));
  return {
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
