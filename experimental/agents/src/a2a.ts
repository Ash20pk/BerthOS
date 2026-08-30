import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import {
  InMemoryTaskStore,
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  AgentEvent,
  defaultServerCallContextBuilder,
  type AgentExecutor,
  type RequestContext,
  type ExecutionEventBus,
} from "@a2a-js/sdk/server";
import { ClientFactory } from "@a2a-js/sdk/client";
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, TaskState, Role, type AgentCard, type Message, type Task } from "@a2a-js/sdk";
import type { Agent } from "./agent.js";
import type { Tool } from "./types.js";

/**
 * `Crew.networked()` is Berth's own wire protocol over a Docker network —
 * real, but not what ADK/Microsoft Agent Framework/LangGraph speak when
 * they interop with an *external* agent (gap #24). A2A (Agent2Agent) is
 * that open protocol: an Agent Card (a JSON manifest) plus JSON-RPC
 * message-send/task-lifecycle semantics. Built on the official
 * `@a2a-js/sdk` (the same reference implementation those frameworks'
 * own A2A support is built against) rather than hand-rolling the wire
 * format — verified against a real client+server round trip using that
 * package directly, not just written to match the spec text. Every
 * request/response/enum shape below was confirmed against the SDK's own
 * runtime behavior, including two real, easy-to-miss details: the JSON-RPC
 * method name for a single message is `"SendMessage"`, not the
 * REST-flavored `message/send` an older spec version used, and a `Part`'s
 * wire-JSON shape is a flat `{text: string}` (the `{content: {$case,
 * value}}` discriminated-union shape is this SDK's *internal* TS
 * representation after parsing, not what crosses the wire).
 */

function textOfMessage(message: Message): string {
  const part = message.parts.find((p) => p.content?.$case === "text");
  return part?.content?.$case === "text" ? part.content.value : "";
}

function isTask(response: Task | Message): response is Task {
  return "status" in response || "artifacts" in response;
}

/** A Task's answer lives in its last artifact's text parts, or (for a Task that ended without ever producing one, e.g. a plain conversational reply) its terminal status's own message. A bare Message response — some agents skip Task tracking entirely for a simple synchronous reply — carries it directly in its own parts. */
function extractResponseText(response: Task | Message): string {
  if (isTask(response)) {
    const lastArtifact = response.artifacts?.at(-1);
    const artifactText = lastArtifact?.parts
      .filter((p) => p.content?.$case === "text")
      .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
      .join("");
    if (artifactText) return artifactText;
    if (response.status?.message) return textOfMessage(response.status.message);
    return "";
  }
  return textOfMessage(response);
}

function buildAgentExecutor(agent: Agent): AgentExecutor {
  return {
    async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
      const userMessage = requestContext.userMessage;
      const { taskId, contextId } = requestContext;
      const input = textOfMessage(userMessage);
      const now = () => new Date().toISOString();

      eventBus.publish(
        AgentEvent.task({
          id: taskId,
          contextId,
          status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: now(), message: undefined },
          artifacts: [],
          history: [userMessage],
          metadata: undefined,
        }),
      );
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: { state: TaskState.TASK_STATE_WORKING, timestamp: now(), message: undefined },
          metadata: undefined,
        }),
      );

      try {
        const result = await agent.run(input);
        eventBus.publish(
          AgentEvent.artifactUpdate({
            taskId,
            contextId,
            artifact: {
              artifactId: randomUUID(),
              name: "Result",
              description: "",
              parts: [{ content: { $case: "text", value: result.text }, metadata: undefined, filename: "", mediaType: "text/plain" }],
              metadata: undefined,
              extensions: [],
            },
            lastChunk: true,
            append: false,
            metadata: undefined,
          }),
        );
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: now(), message: undefined },
            metadata: undefined,
          }),
        );
      } catch (err) {
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: {
              state: TaskState.TASK_STATE_FAILED,
              timestamp: now(),
              message: undefined,
            },
            metadata: { error: err instanceof Error ? err.message : String(err) },
          }),
        );
      }
    },

    // agent.run() has no intermediate yield point to check a cancellation
    // flag against — unlike a hand-written executor looping over its own
    // steps, this whole call is one opaque await. A real interrupt would
    // need Agent.run() to expose a mid-run cancellation hook it doesn't
    // have today; documented here rather than faked with a no-op that
    // pretends to have canceled something.
    async cancelTask(): Promise<void> {},
  };
}

export interface A2aServerOptions {
  /** The URL this agent's Agent Card advertises as where to send requests — override for a real public URL (behind a proxy, a deployed fleet instance). Defaults to `http://localhost:<port>/` for serveAgentAsA2a(), or `http://localhost/` for createA2aRequestHandler() alone (unknown port until something else binds one). */
  url?: string;
  description?: string;
  version?: string;
}

function buildAgentCard(agent: Agent, url: string, options: A2aServerOptions): AgentCard {
  const description = options.description ?? `A Berth Agent ("${agent.name}"), exposed over the A2A protocol.`;
  return {
    name: agent.name,
    description,
    supportedInterfaces: [{ url, protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: undefined,
    version: options.version ?? "0.1.0",
    // Only SendMessage is implemented (see AgentExecutor above) — SendStreamingMessage/SubscribeToTask
    // both require `capabilities.streaming: true`, which would advertise a method this server doesn't serve.
    capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      {
        id: agent.name,
        name: agent.name,
        description,
        tags: [],
        examples: [],
        inputModes: ["text"],
        outputModes: ["text"],
        securityRequirements: [],
      },
    ],
    documentationUrl: "",
    signatures: [],
  };
}

/**
 * A plain Node `(req, res) => Promise<void>` request listener exposing an
 * already-constructed Agent as an A2A server — `GET /<AGENT_CARD_PATH>`
 * (the standard `.well-known/agent-card.json` A2A clients discover an
 * agent at) and `POST /` (JSON-RPC, `SendMessage` only). Composable, same
 * "mount it yourself, or use the owning convenience wrapper" split
 * `createAgentRequestHandler()`/`serveAgent()` already established for the
 * `useChat`-compatible surface (gap #22) — see `serveAgentAsA2a()` below.
 */
export function createA2aRequestHandler(
  agent: Agent,
  options: A2aServerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const url = options.url ?? "http://localhost/";
  const card = buildAgentCard(agent, url, options);
  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), buildAgentExecutor(agent));
  const jsonRpc = new JsonRpcTransportHandler(requestHandler);

  return async (req, res) => {
    if (req.method === "GET" && req.url === `/${AGENT_CARD_PATH}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await requestHandler.getAgentCard()));
      return;
    }

    if (req.method === "POST" && req.url === "/") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } }));
        return;
      }
      const context = defaultServerCallContextBuilder({
        extensions: undefined,
        user: undefined,
        headers: req.headers as Record<string, string | string[] | undefined>,
      });
      const result = await jsonRpc.handle(body as Record<string, unknown>, context);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `not found: GET /${AGENT_CARD_PATH}, POST /` }));
  };
}

export interface A2aServerHandle {
  server: Server;
  close(): Promise<void>;
}

/** The one-call entry point — owns a real http.Server's listen()/close(), mirroring serveAgent()'s own positioning for the useChat-compatible surface. */
export function serveAgentAsA2a(
  agent: Agent,
  options: A2aServerOptions & { port?: number; onListening?: (port: number) => void } = {},
): A2aServerHandle {
  const port = options.port ?? 41241; // matching the a2a-js SDK's own reference samples' conventional default
  const url = options.url ?? `http://localhost:${port}/`;
  const handler = createA2aRequestHandler(agent, { ...options, url });
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });
  server.listen(port, () => options.onListening?.(port));
  return {
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface A2aClientToolOptions {
  /** Shown to the LLM for when to use this tool — defaults to the remote agent card's own description. */
  description?: string;
}

/**
 * Connects to a remote A2A agent (any implementation, not just another
 * Berth agent — ADK, LangGraph, Microsoft Agent Framework, or the official
 * SDK's own samples all work, since this only ever speaks the standard
 * protocol) and wraps it as a Tool: `{task: string}` in, its text answer
 * out — the same `asTool()`-shaped delegation pattern
 * `createMcpClientTools()` already established for MCP servers, applied to
 * an A2A peer instead.
 */
export async function createA2aClientTool(agentCardUrl: string, options: A2aClientToolOptions = {}): Promise<Tool> {
  const factory = new ClientFactory();
  const client = await factory.createFromUrl(agentCardUrl);
  const card = await client.getAgentCard?.();
  const rawName = card?.name ?? "a2a_agent";
  const name = rawName.replace(/[^a-zA-Z0-9_-]/g, "_") || "a2a_agent";

  return {
    name,
    description: options.description ?? card?.description ?? `Delegate a task to the remote A2A agent at ${agentCardUrl}.`,
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "the task to delegate to this agent" } },
      required: ["task"],
    },
    invoke: async (input: unknown): Promise<string> => {
      const { task } = input as { task: string };
      const response = await client.sendMessage({
        message: {
          role: Role.ROLE_USER,
          messageId: randomUUID(),
          parts: [{ content: { $case: "text", value: task }, metadata: undefined, filename: "", mediaType: "text/plain" }],
          taskId: "",
          contextId: "",
          extensions: [],
          metadata: {},
          referenceTaskIds: [],
        },
        configuration: {
          acceptedOutputModes: ["text"],
          taskPushNotificationConfig: undefined,
          historyLength: undefined,
          returnImmediately: false, // block until the remote agent reaches a terminal state, so invoke() has a real answer to return
        },
        metadata: {},
        tenant: "",
      });
      return extractResponseText(response);
    },
  };
}
