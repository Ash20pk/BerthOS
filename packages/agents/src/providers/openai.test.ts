import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenAIProvider } from "./openai.js";
import { createOllamaProvider } from "./ollama.js";
import { startMockLLMServer, openAICompletion } from "./mock-server.js";
import { createLlmGuardrail } from "../guardrails.js";
import { llmJudge } from "../eval.js";
import type { Tool } from "../types.js";

const echoTool: Tool = {
  name: "echo",
  description: "echoes its input",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  invoke: async (input) => input,
};

function provider(url: string) {
  return createOpenAIProvider({ apiKey: "test-key", baseURL: url, maxRetries: 0 });
}

/**
 * REMEDIATION 3.1. The OpenAI API rejects `tools: []` outright, and both LLM
 * judge features (createLlmGuardrail, llmJudge) call chat() with exactly that.
 * The key has to be absent, not empty — this asserts on the serialized body
 * rather than on `body.tools.length`, because "present but empty" is the bug.
 */
test("chat() omits the tools key entirely when the tool list is empty", async () => {
  const server = await startMockLLMServer();
  try {
    server.respondWith(openAICompletion());
    await provider(server.url).chat({ messages: [{ role: "user", text: "hi" }], tools: [] });

    const body = server.onlyRequest().body;
    assert.equal("tools" in body, false, `tools key must be absent, got: ${JSON.stringify(body.tools)}`);
  } finally {
    await server.close();
  }
});

test("chatStream() omits the tools key entirely when the tool list is empty", async () => {
  const server = await startMockLLMServer();
  try {
    server.respondWithStream([
      { id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" } }] },
    ]);
    await provider(server.url).chatStream!({ messages: [{ role: "user", text: "hi" }], tools: [] }, () => {});

    const body = server.onlyRequest().body;
    assert.equal("tools" in body, false, `tools key must be absent, got: ${JSON.stringify(body.tools)}`);
  } finally {
    await server.close();
  }
});

/**
 * The positive control. Every assertion above would also pass against an
 * adapter that had simply stopped sending tools at all, which would break
 * every real agent while looking like a fix.
 */
test("chat() still sends tools when there are some", async () => {
  const server = await startMockLLMServer();
  try {
    server.respondWith(openAICompletion());
    await provider(server.url).chat({ messages: [{ role: "user", text: "hi" }], tools: [echoTool] });

    const body = server.onlyRequest().body;
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].type, "function");
    assert.equal(body.tools[0].function.name, "echo");
    assert.deepEqual(body.tools[0].function.parameters, echoTool.inputSchema);
  } finally {
    await server.close();
  }
});

test("chatStream() still sends tools when there are some", async () => {
  const server = await startMockLLMServer();
  try {
    server.respondWithStream([
      { id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" } }] },
    ]);
    await provider(server.url).chatStream!({ messages: [{ role: "user", text: "hi" }], tools: [echoTool] }, () => {});

    assert.equal(server.onlyRequest().body.tools.length, 1);
  } finally {
    await server.close();
  }
});

/**
 * Azure, Bedrock, and Ollama are all thin wrappers that differ only in how
 * the `openai` client is constructed, then hand it to the same
 * createOpenAICompatibleProvider() — so 3.1 broke all four and one fix closes
 * all four. Asserted through Ollama rather than by reading the source,
 * because "they share the implementation" is exactly the kind of thing that
 * stops being true silently.
 */
test("the derived OpenAI-shaped providers inherit the empty-tools fix", async () => {
  const server = await startMockLLMServer();
  try {
    server.respondWith(openAICompletion());
    await createOllamaProvider({ baseURL: server.url }).chat({ messages: [{ role: "user", text: "hi" }], tools: [] });

    assert.equal("tools" in server.onlyRequest().body, false);
  } finally {
    await server.close();
  }
});

/**
 * The judge call shape verbatim, since that is the code path 3.1 actually
 * broke: no system prompt, one user message, no tools.
 */
/**
 * The two features 3.1 actually broke, driven for real: both call
 * chat({tools: []}) internally, so before the fix both failed against every
 * OpenAI-shaped provider.
 *
 * Each still asserts the request body, and that assertion is the load-bearing
 * one — established by running these against the unfixed adapter, where the
 * feature-level assertions alone passed. This mock accepts `tools: []`
 * happily; OpenAI's API is what rejects it. So a test that only checks the
 * verdict parses cannot reproduce this bug, and a future refactor that
 * reintroduced the empty array would sail past it. Reproducing the API's
 * rejection would mean encoding a vendor's validation rules in a fixture,
 * which goes stale silently; asserting the wire shape does not.
 */
test("createLlmGuardrail() works against an OpenAI-shaped provider", async () => {
  const server = await startMockLLMServer();
  try {
    server.respondWith(
      openAICompletion({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: '{"tripwireTriggered":true,"reason":"leaked a secret"}' },
            finish_reason: "stop",
          },
        ],
      }),
    );

    const guardrail = createLlmGuardrail({ judge: provider(server.url), rubric: "no secrets" });
    const verdict = await guardrail("the password is hunter2");

    assert.equal(verdict.tripwireTriggered, true);
    assert.equal(verdict.message, "leaked a secret");
    assert.equal("tools" in server.onlyRequest().body, false);
  } finally {
    await server.close();
  }
});

test("llmJudge() works against an OpenAI-shaped provider", async () => {
  const server = await startMockLLMServer();
  try {
    server.respondWith(
      openAICompletion({
        choices: [
          { index: 0, message: { role: "assistant", content: '{"pass":false,"reason":"off topic"}' }, finish_reason: "stop" },
        ],
      }),
    );

    const assertion = llmJudge({ judge: provider(server.url), rubric: "must answer the question" });
    const outcome = await assertion({ text: "the weather is nice", toolCalls: [] });

    assert.equal(outcome.pass, false);
    assert.equal(outcome.message, "off topic");
    assert.equal("tools" in server.onlyRequest().body, false);
  } finally {
    await server.close();
  }
});

test("an LLM-judge-shaped call round-trips end to end", async () => {
  const server = await startMockLLMServer();
  try {
    server.respondWith(
      openAICompletion({
        choices: [
          { index: 0, message: { role: "assistant", content: '{"pass":true,"reason":"fine"}' }, finish_reason: "stop" },
        ],
      }),
    );

    const turn = await provider(server.url).chat({ messages: [{ role: "user", text: "judge this" }], tools: [] });

    assert.equal(turn.text, '{"pass":true,"reason":"fine"}');
    assert.equal(turn.stop, true);
    assert.deepEqual(turn.toolCalls, []);
    assert.deepEqual(turn.usage, { inputTokens: 1, outputTokens: 1 });
  } finally {
    await server.close();
  }
});

// --- REMEDIATION 3.7: message mapping, tool round trips, streaming deltas ---

test("maps system prompt, roles, and tool results onto the Chat Completions shape", async () => {
  const server = await startMockLLMServer();
  try {
    server.respondWith(openAICompletion());
    await provider(server.url).chat({
      system: "be terse",
      messages: [
        { role: "user", text: "go" },
        { role: "assistant", text: undefined, toolCalls: [{ id: "call_1", name: "echo", input: { text: "hi" } }] },
        { role: "tool", toolResult: { id: "call_1", name: "echo", output: { text: "hi" } } },
      ],
      tools: [echoTool],
    });

    const messages = server.onlyRequest().body.messages;
    assert.deepEqual(
      messages.map((m: any) => m.role),
      ["system", "user", "assistant", "tool"],
    );
    assert.equal(messages[0].content, "be terse");
    // Tool call arguments cross the wire as a JSON *string*, not an object —
    // getting this wrong is a 400 from the API, not a type error here.
    assert.equal(messages[2].tool_calls[0].function.arguments, '{"text":"hi"}');
    assert.equal(messages[2].tool_calls[0].id, "call_1");
    // A tool result is correlated by tool_call_id; a mismatch here is what
    // produces "tool_call_id did not have response messages".
    assert.equal(messages[3].tool_call_id, "call_1");
    assert.equal(messages[3].content, '{"text":"hi"}');
  } finally {
    await server.close();
  }
});

test("a tool result with no output is sent as JSON null, not the token undefined", async () => {
  const server = await startMockLLMServer();
  try {
    server.respondWith(openAICompletion());
    await provider(server.url).chat({
      messages: [{ role: "tool", toolResult: { id: "call_1", name: "noop", output: undefined } }],
      tools: [],
    });

    const content = server.onlyRequest().body.messages[0].content;
    assert.equal(content, "null");
    assert.equal(JSON.parse(content), null);
  } finally {
    await server.close();
  }
});

test("reads a tool call back out of a response", async () => {
  const server = await startMockLLMServer();
  try {
    server.respondWith(
      openAICompletion({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_9", type: "function", function: { name: "echo", arguments: '{"text":"hi"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );

    const turn = await provider(server.url).chat({ messages: [{ role: "user", text: "go" }], tools: [echoTool] });

    assert.deepEqual(turn.toolCalls, [{ id: "call_9", name: "echo", input: { text: "hi" } }]);
    assert.equal(turn.stop, false);
    assert.equal(turn.stopReason, "tool_calls");
    assert.equal(turn.text, undefined);
  } finally {
    await server.close();
  }
});

/**
 * Streaming tool calls arrive fragmented: the id and name land on the first
 * frame, and the JSON arguments are split across arbitrarily many later ones,
 * keyed only by index. Reassembling that is the single most intricate piece
 * of logic in these adapters and had no test at all.
 */
test("chatStream() reassembles a tool call fragmented across frames", async () => {
  const server = await startMockLLMServer();
  try {
    const frame = (delta: unknown, finish: string | null = null) => ({
      id: "1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    server.respondWithStream([
      frame({ role: "assistant", tool_calls: [{ index: 0, id: "call_7", type: "function", function: { name: "ec" } }] }),
      frame({ tool_calls: [{ index: 0, function: { name: "ho" } }] }),
      frame({ tool_calls: [{ index: 0, function: { arguments: '{"te' } }] }),
      frame({ tool_calls: [{ index: 0, function: { arguments: 'xt":"hi"}' } }] }),
      frame({}, "tool_calls"),
    ]);

    const turn = await provider(server.url).chatStream!({ messages: [{ role: "user", text: "go" }], tools: [echoTool] }, () => {});

    assert.deepEqual(turn.toolCalls, [{ id: "call_7", name: "echo", input: { text: "hi" } }]);
    assert.equal(turn.stopReason, "tool_calls");
  } finally {
    await server.close();
  }
});

test("chatStream() delivers text deltas in order and returns the joined text", async () => {
  const server = await startMockLLMServer();
  try {
    const frame = (delta: unknown, finish: string | null = null) => ({
      id: "1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    server.respondWithStream([
      frame({ role: "assistant", content: "Hel" }),
      frame({ content: "lo " }),
      frame({ content: "there" }),
      frame({}, "stop"),
    ]);

    const deltas: string[] = [];
    const turn = await provider(server.url).chatStream!(
      { messages: [{ role: "user", text: "hi" }], tools: [] },
      (d) => deltas.push(d),
    );

    assert.deepEqual(deltas, ["Hel", "lo ", "there"]);
    assert.equal(turn.text, "Hello there");
    assert.equal(turn.stopReason, "end");
  } finally {
    await server.close();
  }
});

/**
 * With include_usage the last frame is a usage-only one whose choices array
 * is empty — so reading finish_reason off "the final chunk" yields nothing.
 * This asserts the adapter keeps the last non-null it saw instead.
 */
test("chatStream() still reports the stop reason when a usage-only frame comes last", async () => {
  const server = await startMockLLMServer();
  try {
    server.respondWithStream([
      { id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "cut" }, finish_reason: null }] },
      { id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
      { id: "1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 5, completion_tokens: 6 } },
    ]);

    const turn = await provider(server.url).chatStream!({ messages: [{ role: "user", text: "hi" }], tools: [] }, () => {});

    assert.equal(turn.stopReason, "length");
    assert.deepEqual(turn.usage, { inputTokens: 5, outputTokens: 6 });
  } finally {
    await server.close();
  }
});
