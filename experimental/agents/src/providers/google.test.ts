import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoogleProvider } from "./google.js";
import { startMockLLMServer } from "./mock-server.js";
import type { AgentMessage, Tool } from "../types.js";

const echoTool: Tool = {
  name: "echo",
  description: "echoes its input",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  invoke: async (input) => input,
};

/** A minimal well-formed generateContent response. */
function geminiResponse(parts: unknown[], finishReason = "STOP") {
  return {
    candidates: [{ content: { role: "model", parts }, finishReason, index: 0 }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
  };
}

function provider(url: string) {
  return createGoogleProvider({ apiKey: "test-key", baseUrl: url });
}

async function exchange(messages: AgentMessage[], tools: Tool[], response: unknown) {
  const server = await startMockLLMServer();
  try {
    server.respondWith(response);
    const turn = await provider(server.url).chat({ messages, tools });
    return { turn, request: server.onlyRequest() };
  } finally {
    await server.close();
  }
}

/**
 * REMEDIATION 3.7. Gemini's Content/Part/FunctionCall shapes are genuinely
 * different from the other two vendors' rather than a relabeling, so this is
 * where a mapping bug would be most likely and least visible. Every
 * assertion here is on what actually went over the wire.
 */
test("maps roles onto Gemini's user/model vocabulary", async () => {
  const { request } = await exchange(
    [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ],
    [],
    geminiResponse([{ text: "ok" }]),
  );

  assert.deepEqual(
    request.body.contents.map((c: any) => c.role),
    ["user", "model"],
  );
  assert.equal(request.body.contents[1].parts[0].text, "hello");
});

test("sends the system prompt as systemInstruction, not as a message", async () => {
  const server = await startMockLLMServer();
  try {
    server.respondWith(geminiResponse([{ text: "ok" }]));
    await provider(server.url).chat({ system: "be terse", messages: [{ role: "user", text: "hi" }], tools: [] });

    const body = server.onlyRequest().body;
    assert.equal(body.contents.length, 1);
    assert.equal(body.systemInstruction.parts[0].text, "be terse");
  } finally {
    await server.close();
  }
});

/**
 * google.ts already guarded the empty-tools case that broke the OpenAI family
 * (3.1) — asserted rather than assumed, since "this one was already correct"
 * is exactly the kind of claim that rots.
 *
 * Note the path: the SDK flattens the `config` object this adapter builds
 * into top-level request keys, so `tools` lands at the root and `config`
 * never appears on the wire at all. An assertion against `body.config.tools`
 * passes no matter what the adapter does — which is what the first draft of
 * this test did, and why these assert on a real request rather than on the
 * arguments handed to a stubbed client.
 */
test("omits tools entirely when the tool list is empty", async () => {
  const { request } = await exchange([{ role: "user", text: "hi" }], [], geminiResponse([{ text: "ok" }]));
  assert.equal("tools" in request.body, false, `tools key must be absent, got: ${JSON.stringify(request.body.tools)}`);
});

test("sends function declarations when there are tools", async () => {
  const { request } = await exchange([{ role: "user", text: "hi" }], [echoTool], geminiResponse([{ text: "ok" }]));

  const declarations = request.body.tools[0].functionDeclarations;
  assert.equal(declarations.length, 1);
  assert.equal(declarations[0].name, "echo");
  assert.deepEqual(declarations[0].parametersJsonSchema, echoTool.inputSchema);
});

test("reads a function call back out as a tool call", async () => {
  const { turn } = await exchange(
    [{ role: "user", text: "echo hi" }],
    [echoTool],
    geminiResponse([{ functionCall: { id: "fc1", name: "echo", args: { text: "hi" } } }]),
  );

  assert.deepEqual(turn.toolCalls, [{ id: "fc1", name: "echo", input: { text: "hi" } }]);
  assert.equal(turn.stop, false);
  assert.equal(turn.stopReason, "tool_calls");
  assert.deepEqual(turn.usage, { inputTokens: 3, outputTokens: 4 });
});

/**
 * Gemini reports STOP even on a turn that called a function, so a naive
 * mapping would label a tool-call turn "end" and tell the loop the model was
 * finished when it was waiting on a result.
 */
test("a tool-call turn is not reported as a normal ending despite Gemini's STOP", async () => {
  const { turn } = await exchange(
    [{ role: "user", text: "go" }],
    [echoTool],
    geminiResponse([{ functionCall: { id: "fc1", name: "echo", args: {} } }], "STOP"),
  );
  assert.equal(turn.stopReason, "tool_calls");
});

test("maps Gemini's finish reasons, collapsing its several suppression modes", async () => {
  async function reasonFor(finishReason: string) {
    const { turn } = await exchange([{ role: "user", text: "hi" }], [], geminiResponse([{ text: "x" }], finishReason));
    return turn.stopReason;
  }

  assert.equal(await reasonFor("STOP"), "end");
  assert.equal(await reasonFor("MAX_TOKENS"), "length");
  assert.equal(await reasonFor("SAFETY"), "content_filter");
  assert.equal(await reasonFor("RECITATION"), "content_filter");
  assert.equal(await reasonFor("PROHIBITED_CONTENT"), "content_filter");
  assert.equal(await reasonFor("MALFORMED_FUNCTION_CALL"), "other");
});

/**
 * The one real shape mismatch in this adapter: Gemini requires a
 * FunctionResponse's `response` to be a JSON object, while the other two
 * vendors accept any JSON value. A bare string or array has to be wrapped or
 * the API rejects the request outright.
 */
test("wraps a non-object tool output so the function response stays a JSON object", async () => {
  const { request } = await exchange(
    [
      { role: "user", text: "go" },
      { role: "assistant", text: undefined, toolCalls: [{ id: "fc1", name: "echo", input: {} }] },
      { role: "tool", toolResult: { id: "fc1", name: "echo", output: "a bare string" } },
    ],
    [echoTool],
    geminiResponse([{ text: "done" }]),
  );

  const functionResponse = request.body.contents[2].parts[0].functionResponse;
  assert.equal(functionResponse.name, "echo");
  assert.deepEqual(functionResponse.response, { result: "a bare string" });
});

test("passes an object tool output through unwrapped", async () => {
  const { request } = await exchange(
    [
      { role: "user", text: "go" },
      { role: "assistant", text: undefined, toolCalls: [{ id: "fc1", name: "echo", input: {} }] },
      { role: "tool", toolResult: { id: "fc1", name: "echo", output: { ok: true } } },
    ],
    [echoTool],
    geminiResponse([{ text: "done" }]),
  );

  assert.deepEqual(request.body.contents[2].parts[0].functionResponse.response, { ok: true });
});
