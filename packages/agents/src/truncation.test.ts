import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Agent } from "./agent.js";
import { createOpenAIProvider } from "./providers/openai.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { startMockLLMServer, openAICompletion, anthropicMessage } from "./providers/mock-server.js";
import { TruncatedResponseError, type LLMProvider, type LLMStopReason, type LLMTurn } from "./types.js";

/**
 * REMEDIATION 3.2. Two halves, tested separately because they fail
 * separately: providers have to *report* why a turn ended, and the loop has
 * to *act* on it. Before this, no provider read finish_reason/stop_reason at
 * all, so a response cut off at the token cap arrived with `toolCalls: []`
 * and agent.ts returned the fragment as the final answer.
 */

// --- Half one: providers report a normalized stop reason ---

async function openAITurn(finishReason: string | null, extra: Record<string, unknown> = {}): Promise<LLMTurn> {
  const server = await startMockLLMServer();
  try {
    server.respondWith(
      openAICompletion({
        choices: [{ index: 0, message: { role: "assistant", content: "partial", ...extra }, finish_reason: finishReason }],
      }),
    );
    return await createOpenAIProvider({ apiKey: "k", baseURL: server.url, maxRetries: 0 }).chat({
      messages: [{ role: "user", text: "hi" }],
      tools: [],
    });
  } finally {
    await server.close();
  }
}

test("the OpenAI adapter maps finish_reason onto a normalized stopReason", async () => {
  assert.equal((await openAITurn("stop")).stopReason, "end");
  assert.equal((await openAITurn("length")).stopReason, "length");
  assert.equal((await openAITurn("content_filter")).stopReason, "content_filter");
  assert.equal((await openAITurn("tool_calls")).stopReason, "tool_calls");
});

test("an OpenAI refusal is reported as a refusal, not as a normal ending", async () => {
  const turn = await openAITurn("stop", { refusal: "I can't help with that" });
  assert.equal(turn.stopReason, "refusal");
});

/**
 * Absent must mean "unknown", never "fine". Plenty of OpenAI-compatible
 * servers (llama.cpp, vLLM, older Ollama builds) omit finish_reason, and
 * defaulting those to "end" would be asserting a completion nobody reported.
 * The loop leaves an undefined stopReason alone, so this is what keeps every
 * such server working.
 */
test("a missing finish_reason maps to undefined, not to a fabricated ending", async () => {
  assert.equal((await openAITurn(null)).stopReason, undefined);
  assert.equal((await openAITurn("something_new")).stopReason, "other");
});

test("the Anthropic adapter maps stop_reason onto a normalized stopReason", async () => {
  async function anthropicTurn(stopReason: string) {
    const server = await startMockLLMServer();
    try {
      server.respondWith(anthropicMessage({ stop_reason: stopReason }));
      return await createAnthropicProvider({ apiKey: "k", baseURL: server.url, maxRetries: 0 }).chat({
        messages: [{ role: "user", text: "hi" }],
        tools: [],
      });
    } finally {
      await server.close();
    }
  }

  assert.equal((await anthropicTurn("end_turn")).stopReason, "end");
  assert.equal((await anthropicTurn("max_tokens")).stopReason, "length");
  assert.equal((await anthropicTurn("tool_use")).stopReason, "tool_calls");
  assert.equal((await anthropicTurn("refusal")).stopReason, "refusal");
  // A server-tool pause is not an ending — mapping it to "end" would assert a
  // completion the model never signalled.
  assert.equal((await anthropicTurn("pause_turn")).stopReason, "other");
});

// --- Half two: the loop refuses to present a truncated turn as an answer ---

function providerReturning(turn: Partial<LLMTurn>): LLMProvider {
  return {
    name: "stub",
    async chat() {
      return { text: "partial answ", toolCalls: [], stop: true, ...turn } as LLMTurn;
    },
  };
}

function agentWith(turn: Partial<LLMTurn>) {
  return new Agent({ name: "test-agent", llm: providerReturning(turn), tools: [] });
}

test("a length-truncated turn throws instead of being returned as the final answer", async () => {
  await assert.rejects(
    () => agentWith({ stopReason: "length" }).run("write me an essay"),
    (err: unknown) => {
      assert.ok(err instanceof TruncatedResponseError);
      assert.equal(err.stopReason, "length");
      assert.equal(err.agentName, "test-agent");
      // The fragment is preserved for a caller that wants to salvage it.
      assert.equal(err.partialText, "partial answ");
      assert.match(err.message, /token limit/);
      return true;
    },
  );
});

test("a content-filtered turn throws", async () => {
  await assert.rejects(() => agentWith({ stopReason: "content_filter" }).run("x"), TruncatedResponseError);
});

test("a refused turn throws", async () => {
  await assert.rejects(() => agentWith({ stopReason: "refusal" }).run("x"), TruncatedResponseError);
});

/**
 * The positive controls. Every assertion above would also pass against a loop
 * that had simply started throwing on everything.
 */
test("a normally-ended turn is returned as the final answer", async () => {
  const result = await agentWith({ stopReason: "end", text: "the whole answer" }).run("x");
  assert.equal(result.text, "the whole answer");
});

test("a turn with no stopReason at all still works, unchanged", async () => {
  const result = await agentWith({ text: "the whole answer" }).run("x");
  assert.equal(result.text, "the whole answer");
});

test('an unmapped "other" stopReason is left alone rather than treated as suspect', async () => {
  const result = await agentWith({ stopReason: "other", text: "still an answer" }).run("x");
  assert.equal(result.text, "still an answer");
});

/**
 * The responseSchema interaction is the expensive half of this bug: a
 * truncated response is half-JSON, which can never parse, so the repair loop
 * burned every attempt (and every token) re-asking a model that was going to
 * be cut off at the same place. Throwing on the first truncated turn is what
 * stops that. Asserted by counting calls, since "failed after N attempts"
 * and "failed immediately" both just throw.
 */
test("a truncated turn under responseSchema fails immediately instead of burning repair attempts", async () => {
  let calls = 0;
  const llm: LLMProvider = {
    name: "stub",
    async chat() {
      calls++;
      return { text: '{"answer": "half', toolCalls: [], stop: true, stopReason: "length" as LLMStopReason };
    },
  };
  const agent = new Agent({ name: "schema-agent", llm, tools: [] });

  await assert.rejects(
    () => agent.run("x", { responseSchema: z.object({ answer: z.string() }), maxRepairAttempts: 5 }),
    TruncatedResponseError,
  );
  assert.equal(calls, 1, `expected to give up after one truncated turn, made ${calls} calls`);
});

/**
 * A truncated turn can end mid-arguments, so any tool call recovered from one
 * may carry incomplete JSON — which is why the check runs before the tool
 * calls are looked at, not only on the no-tool-calls path where the original
 * bug showed up.
 */
test("a truncated turn that also carries tool calls throws rather than executing them", async () => {
  let invoked = false;
  const llm: LLMProvider = {
    name: "stub",
    async chat() {
      return {
        text: undefined,
        toolCalls: [{ id: "t1", name: "danger", input: {} }],
        stop: false,
        stopReason: "length" as LLMStopReason,
      };
    },
  };
  const agent = new Agent({
    name: "tool-agent",
    llm,
    tools: [
      {
        name: "danger",
        description: "",
        inputSchema: { type: "object" },
        invoke: async () => {
          invoked = true;
          return {};
        },
      },
    ],
  });

  await assert.rejects(() => agent.run("x"), TruncatedResponseError);
  assert.equal(invoked, false, "a tool call recovered from a truncated turn must not execute");
});
