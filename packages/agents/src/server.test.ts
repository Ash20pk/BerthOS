import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema } from "ai";
import { Agent } from "./agent.js";
import { createAgentRequestHandler, serveAgent } from "./server.js";
import type { LLMProvider, LLMTurn, Tool } from "./types.js";

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

/** A provider with chatStream — the streamed-onText path server.test.ts's /chat tests exercise. Delivers text one character at a time so a real multi-chunk stream is observable. */
function streamingLLM(text: string): LLMProvider {
  return {
    name: "fake-streaming",
    async chat() {
      return { text, toolCalls: [], stop: true };
    },
    async chatStream(_input, onText) {
      for (const char of text) onText(char);
      return { text, toolCalls: [], stop: true };
    },
  };
}

function echoTool(name: string, result: unknown = "tool-result"): Tool {
  return { name, description: "", inputSchema: {}, invoke: async () => result };
}

async function withServer<T>(agent: Agent, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const handler = createAgentRequestHandler(agent);
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a real port");
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("GET /health reports ok and the agent's tool names", async () => {
  const agent = new Agent({ llm: scriptedLLM([]), tools: [echoTool("search")] });
  await withServer(agent, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, tools: ["search"] });
  });
});

test("POST /task runs the agent and returns {text, toolCalls}", async () => {
  const agent = new Agent({ llm: scriptedLLM([{ text: "done", toolCalls: [], stop: true }]), tools: [] });
  await withServer(agent, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "do the thing" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "done", toolCalls: [] });
  });
});

test("POST /task with a sessionId shares history across separate requests", async () => {
  let seenMessageCount = 0;
  const llm: LLMProvider = {
    name: "fake",
    async chat({ messages }) {
      seenMessageCount = messages.length;
      return { text: "ok", toolCalls: [], stop: true };
    },
  };
  const agent = new Agent({ llm, tools: [] });
  await withServer(agent, async (baseUrl) => {
    await fetch(`${baseUrl}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "first", sessionId: "abc" }),
    });
    assert.equal(seenMessageCount, 1);

    await fetch(`${baseUrl}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "second", sessionId: "abc" }),
    });
    // first user turn + first assistant answer + this new user turn
    assert.equal(seenMessageCount, 3);
  });
});

test("POST /task rejects a missing/empty task with 400", async () => {
  const agent = new Agent({ llm: scriptedLLM([]), tools: [] });
  await withServer(agent, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
  });
});

test("POST /task returns 500 with the error message when the agent throws", async () => {
  const llm: LLMProvider = {
    name: "fake",
    async chat() {
      throw new Error("provider unavailable");
    },
  };
  const agent = new Agent({ llm, tools: [] });
  await withServer(agent, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "do it" }),
    });
    assert.equal(response.status, 500);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /provider unavailable/);
  });
});

test("an unknown route returns 404", async () => {
  const agent = new Agent({ llm: scriptedLLM([]), tools: [] });
  await withServer(agent, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/nope`);
    assert.equal(response.status, 404);
  });
});

test("POST /chat streams a real AI SDK UI Message Stream the `ai` package's own client can parse", async () => {
  const agent = new Agent({ llm: streamingLLM("hello world"), tools: [] });
  await withServer(agent, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }] }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("x-vercel-ai-ui-message-stream"), "v1");

    const chunkStream = parseJsonEventStream({ stream: response.body!, schema: uiMessageChunkSchema }).pipeThrough(
      new TransformStream({
        transform(parseResult, controller) {
          if (parseResult.success) controller.enqueue(parseResult.value);
        },
      }),
    );

    let finalMessage;
    for await (const message of readUIMessageStream({ stream: chunkStream })) {
      finalMessage = message;
    }

    assert.ok(finalMessage);
    const textPart = finalMessage.parts.find((p) => p.type === "text");
    assert.equal(textPart?.text, "hello world");
  });
});

test("POST /chat's prior messages become session history the agent actually sees", async () => {
  let seenMessages: unknown;
  const llm: LLMProvider = {
    name: "fake",
    async chat({ messages }) {
      seenMessages = [...messages]; // a copy — the agent keeps mutating the same array after this call returns
      return { text: "Paris has about 2 million people", toolCalls: [], stop: true };
    },
  };
  const agent = new Agent({ llm, tools: [] });
  await withServer(agent, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { id: "1", role: "user", parts: [{ type: "text", text: "what's the capital of France?" }] },
          { id: "2", role: "assistant", parts: [{ type: "text", text: "Paris" }] },
          { id: "3", role: "user", parts: [{ type: "text", text: "and its population?" }] },
        ],
      }),
    });
    // Drain the stream so the request actually completes.
    await response.text();

    assert.deepEqual(seenMessages, [
      { role: "user", text: "what's the capital of France?" },
      { role: "assistant", text: "Paris" },
      { role: "user", text: "and its population?" },
    ]);
  });
});

test("POST /chat falls back to one full-text chunk when the provider has no chatStream", async () => {
  const agent = new Agent({ llm: scriptedLLM([{ text: "no streaming here", toolCalls: [], stop: true }]), tools: [] });
  await withServer(agent, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }] }),
    });

    const chunkStream = parseJsonEventStream({ stream: response.body!, schema: uiMessageChunkSchema }).pipeThrough(
      new TransformStream({
        transform(parseResult, controller) {
          if (parseResult.success) controller.enqueue(parseResult.value);
        },
      }),
    );
    let finalMessage;
    for await (const message of readUIMessageStream({ stream: chunkStream })) {
      finalMessage = message;
    }
    assert.equal(finalMessage?.parts.find((p) => p.type === "text")?.text, "no streaming here");
  });
});

test("POST /chat with no user message returns 400", async () => {
  const agent = new Agent({ llm: scriptedLLM([]), tools: [] });
  await withServer(agent, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(response.status, 400);
  });
});

test("serveAgent() owns a real listen()/close() lifecycle", async () => {
  const agent = new Agent({ llm: scriptedLLM([]), tools: [] });
  const handle = serveAgent(agent, { port: 0 });
  await new Promise<void>((resolve) => handle.server.once("listening", resolve));
  const address = handle.server.address();
  if (!address || typeof address === "string") throw new Error("expected a real port");

  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);

  await handle.close();
});
