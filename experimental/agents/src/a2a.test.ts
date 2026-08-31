import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { Agent } from "./agent.js";
import { createA2aRequestHandler, createA2aClientTool, serveAgentAsA2a } from "./a2a.js";
import type { LLMProvider, LLMTurn } from "./types.js";

function scriptedLLM(turns: LLMTurn[]): LLMProvider {
  let i = 0;
  return {
    name: "fake",
    async chat() {
      const turn = turns[i];
      if (!turn) throw new Error("script exhausted");
      i++;
      return turn;
    },
  };
}

async function withServer<T>(
  agent: Agent,
  fn: (baseUrl: string) => Promise<T>,
  optionsFor?: (baseUrl: string) => Parameters<typeof createA2aRequestHandler>[1],
): Promise<T> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a real port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // The AgentCard needs the server's own real URL baked in (a client
  // resolves where to send follow-up requests from what's *inside* the
  // card, not from whatever URL it fetched the card from) — only knowable
  // after listen() assigns an ephemeral port, so the handler is built and
  // attached after binding rather than passed to createServer() directly.
  const handler = createA2aRequestHandler(agent, optionsFor?.(baseUrl));
  server.on("request", (req, res) => {
    handler(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });

  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("GET /<AGENT_CARD_PATH> serves a real Agent Card naming the agent", async () => {
  const agent = new Agent({ llm: scriptedLLM([]), tools: [], name: "research-assistant" });
  await withServer(agent, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/${AGENT_CARD_PATH}`);
    assert.equal(response.status, 200);
    const card = (await response.json()) as { name: string; capabilities: { streaming: boolean } };
    assert.equal(card.name, "research-assistant");
    assert.equal(card.capabilities.streaming, false);
  });
});

test("POST / with a real SendMessage JSON-RPC request runs the agent and returns a completed Task", async () => {
  const agent = new Agent({ llm: scriptedLLM([{ text: "hello from the agent", toolCalls: [], stop: true }]), tools: [] });
  await withServer(agent, async (baseUrl) => {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "SendMessage",
        params: {
          message: {
            role: "ROLE_USER",
            messageId: "m1",
            parts: [{ text: "hi" }],
            taskId: "",
            contextId: "",
            extensions: [],
            metadata: {},
            referenceTaskIds: [],
          },
          configuration: { acceptedOutputModes: ["text"], returnImmediately: false },
          metadata: {},
        },
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      result: { task: { status: { state: string }; artifacts: { parts: { text: string }[] }[] } };
    };
    assert.equal(body.result.task.status.state, "TASK_STATE_COMPLETED");
    assert.equal(body.result.task.artifacts[0]?.parts[0]?.text, "hello from the agent");
  });
});

test("a failing agent run reports TASK_STATE_FAILED instead of throwing out of the handler", async () => {
  const llm: LLMProvider = {
    name: "fake",
    async chat() {
      throw new Error("provider unavailable");
    },
  };
  const agent = new Agent({ llm, tools: [] });
  await withServer(agent, async (baseUrl) => {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "SendMessage",
        params: {
          message: { role: "ROLE_USER", messageId: "m1", parts: [{ text: "hi" }], taskId: "", contextId: "" },
          configuration: { acceptedOutputModes: ["text"], returnImmediately: false },
          metadata: {},
        },
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { result: { task: { status: { state: string } } } };
    assert.equal(body.result.task.status.state, "TASK_STATE_FAILED");
  });
});

test("an unknown route returns 404", async () => {
  const agent = new Agent({ llm: scriptedLLM([]), tools: [] });
  await withServer(agent, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/nope`);
    assert.equal(response.status, 404);
  });
});

test("createA2aClientTool consumes a real running server end to end, using the actual @a2a-js/sdk client", async () => {
  const agent = new Agent({
    llm: scriptedLLM([{ text: "the answer from the remote agent", toolCalls: [], stop: true }]),
    tools: [],
    name: "remote-agent",
  });

  await withServer(
    agent,
    async (baseUrl) => {
      const tool = await createA2aClientTool(`${baseUrl}/`);
      assert.equal(tool.name, "remote-agent");

      const result = await tool.invoke({ task: "what is the answer?" });
      assert.equal(result, "the answer from the remote agent");
    },
    (baseUrl) => ({ url: `${baseUrl}/` }),
  );
});

test("createA2aClientTool's description defaults to the remote agent card's own description", async () => {
  const agent = new Agent({ llm: scriptedLLM([]), tools: [], name: "described-agent" });
  await withServer(
    agent,
    async (baseUrl) => {
      const tool = await createA2aClientTool(`${baseUrl}/`);
      assert.match(tool.description, /described-agent/);
    },
    (baseUrl) => ({ url: `${baseUrl}/`, description: "A test agent named described-agent." }),
  );
});

test("serveAgentAsA2a() owns a real listen()/close() lifecycle", async () => {
  const agent = new Agent({ llm: scriptedLLM([]), tools: [] });
  const handle = serveAgentAsA2a(agent, { port: 0 });
  await new Promise<void>((resolve) => handle.server.once("listening", resolve));
  const address = handle.server.address();
  if (!address || typeof address === "string") throw new Error("expected a real port");

  const response = await fetch(`http://127.0.0.1:${address.port}/${AGENT_CARD_PATH}`);
  assert.equal(response.status, 200);

  await handle.close();
});
