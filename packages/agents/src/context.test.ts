import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.js";
import { SUMMARY_PREFIX, compactMessages, emergencyBudget, estimateFixedTokens, estimateMessageTokens } from "./context.js";
import { ContextLengthExceededError } from "./errors.js";
import type { AgentMessage, LLMProvider, Tool } from "./types.js";

function userMessage(text: string): AgentMessage {
  return { role: "user", text };
}

/** An assistant turn plus the tool result answering it — the pair a trim must never split. */
function toolExchange(id: string, size = 100): AgentMessage[] {
  return [
    { role: "assistant", toolCalls: [{ id, name: "read_file", input: { path: "x".repeat(size) } }] },
    { role: "tool", toolResult: { id, name: "read_file", output: { content: "y".repeat(size) } } },
  ];
}

const NO_FIXED = 0;

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

test("counts tool-call arguments and tool-result payloads, not just text", () => {
  // A text-only count misses the largest part of an agentic history, which is
  // exactly the history that overflows a window.
  const textOnly = estimateMessageTokens(userMessage("hello"));
  const withPayload = estimateMessageTokens(toolExchange("1", 4000)[1]!);
  assert.ok(withPayload > textOnly * 50, `expected the payload to dominate, got ${withPayload} vs ${textOnly}`);
});

test("counts the system prompt and tool schemas, which are re-sent every turn", () => {
  const tools: Tool[] = [
    { name: "read_file", description: "reads a file", inputSchema: { type: "object", properties: { path: { type: "string" } } }, invoke: async () => "" },
  ];
  assert.ok(estimateFixedTokens("you are helpful", tools) > estimateFixedTokens(undefined, []));
});

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

test("leaves a history that already fits completely alone", async () => {
  const messages = [userMessage("hi"), userMessage("there")];
  const result = await compactMessages(messages, NO_FIXED, { maxInputTokens: 10_000 });
  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
});

test("does nothing when no budget is set", async () => {
  const messages = Array.from({ length: 100 }, (_, i) => userMessage("x".repeat(1000) + i));
  const result = await compactMessages(messages, NO_FIXED, {});
  assert.equal(result.compacted, false);
});

test("drops the oldest messages when over budget, keeping the newest", async () => {
  const messages = Array.from({ length: 40 }, (_, i) => userMessage(`message ${i} ` + "x".repeat(400)));
  const result = await compactMessages(messages, NO_FIXED, { maxInputTokens: 2_000, reserveTokens: 0 });

  assert.equal(result.compacted, true);
  assert.ok(result.messages.length < messages.length);
  // The most recent turn is the one the model is answering.
  assert.equal(result.messages.at(-1), messages.at(-1));
  assert.ok(!result.messages.includes(messages[0]!), "oldest message should have been dropped");
});

test("never splits an assistant tool call from its result", async () => {
  // The invariant that makes this more than a slice(): every vendor rejects
  // an assistant message whose tool_calls have no matching results, and
  // rejects a tool result with no preceding call. A trim that cuts between
  // them converts a context-length error into a hard 400 on every subsequent
  // turn — strictly worse than the problem being solved.
  const messages: AgentMessage[] = [];
  for (let i = 0; i < 20; i++) {
    messages.push(userMessage(`task ${i} ` + "x".repeat(300)), ...toolExchange(`call-${i}`, 300));
  }

  const result = await compactMessages(messages, NO_FIXED, {
    maxInputTokens: 3_000,
    reserveTokens: 0,
    keepRecentMessages: 2,
  });
  assert.equal(result.compacted, true);

  const open = new Set<string>();
  for (const message of result.messages) {
    for (const call of message.toolCalls ?? []) open.add(call.id);
    if (message.toolResult) {
      assert.ok(open.has(message.toolResult.id), `orphan tool result for ${message.toolResult.id}`);
      open.delete(message.toolResult.id);
    }
  }
  assert.equal(open.size, 0, "every kept tool call should have its result");
});

test("keeps the protected tail even when the budget is impossibly small", async () => {
  // Sending nothing is not an improvement on sending too much: the provider
  // gets to return a real, actionable error instead.
  const messages = Array.from({ length: 10 }, (_, i) => userMessage("x".repeat(4000) + i));
  const result = await compactMessages(messages, NO_FIXED, { maxInputTokens: 10, reserveTokens: 0, keepRecentMessages: 3 });
  assert.ok(result.messages.length >= 3);
  assert.equal(result.messages.at(-1), messages.at(-1));
});

test("replaces dropped messages with a summary when one is configured", async () => {
  const messages = Array.from({ length: 30 }, (_, i) => userMessage(`turn ${i} ` + "x".repeat(400)));
  let summarized: AgentMessage[] = [];

  const result = await compactMessages(messages, NO_FIXED, {
    maxInputTokens: 2_000,
    reserveTokens: 0,
    summarize: async (dropped) => {
      summarized = dropped;
      return "they discussed 30 things";
    },
  });

  assert.equal(result.compacted, true);
  assert.ok(summarized.length > 0, "summarizer should have received the dropped messages");
  assert.equal(result.messages[0]!.role, "user");
  // Prefixed so it can't be mistaken for something the user actually typed.
  assert.match(result.messages[0]!.text!, new RegExp(`^\\${SUMMARY_PREFIX[0]}`));
  assert.match(result.messages[0]!.text!, /they discussed 30 things/);
});

test("emergencyBudget lands below what the provider just rejected", async () => {
  const messages = Array.from({ length: 20 }, () => userMessage("x".repeat(1000)));
  const used = messages.reduce((t, m) => t + estimateMessageTokens(m), 0);
  const budget = emergencyBudget(messages, NO_FIXED);
  // No API exposes the real window and the error text doesn't reliably carry
  // it, so the only safe reference point is the size of the thing that was
  // just refused.
  assert.ok(budget < used, `${budget} should be under ${used}`);
  assert.ok(budget > 0);
});

// ---------------------------------------------------------------------------
// Through a real Agent
// ---------------------------------------------------------------------------

test("a long session is compacted before the call instead of growing unboundedly", async () => {
  let sentMessageCount = 0;
  const llm: LLMProvider = {
    name: "counts",
    chat: async ({ messages }) => {
      sentMessageCount = messages.length;
      return { text: "ok", toolCalls: [], stop: true };
    },
  };
  const agent = new Agent({
    llm,
    tools: [],
    context: { maxInputTokens: 1_000, reserveTokens: 0, keepRecentMessages: 2 },
  });

  const history = Array.from({ length: 200 }, (_, i) => userMessage(`old turn ${i} ` + "x".repeat(200)));
  await agent.run("what did we decide?", {
    session: {
      getItems: async () => history,
      addItems: async () => {},
      clear: async () => {},
    },
  });

  assert.ok(sentMessageCount < 200, `expected compaction, but all ${sentMessageCount} messages were sent`);
});

test("recovers from a provider context-length error by trimming and retrying", async () => {
  // The failure this exists for: without the retry, a session that outgrew
  // the window fails here and on every subsequent run() forever.
  let calls = 0;
  let secondCallMessageCount = 0;
  const llm: LLMProvider = {
    name: "overflows-once",
    chat: async ({ messages }) => {
      calls++;
      if (calls === 1) throw new ContextLengthExceededError("overflows-once", "maximum context length is 8192 tokens");
      secondCallMessageCount = messages.length;
      return { text: "recovered", toolCalls: [], stop: true };
    },
  };
  const agent = new Agent({ llm, tools: [] });

  const history = Array.from({ length: 100 }, (_, i) => userMessage(`turn ${i} ` + "x".repeat(400)));
  const result = await agent.run("continue", {
    session: { getItems: async () => history, addItems: async () => {}, clear: async () => {} },
  });

  assert.equal(result.text, "recovered");
  assert.equal(calls, 2, "should have retried exactly once");
  assert.ok(secondCallMessageCount < 101, "the retry should have sent less than the rejected request");
});

test("gives up rather than looping when compaction can't free anything more", async () => {
  let calls = 0;
  const llm: LLMProvider = {
    name: "always-overflows",
    chat: async () => {
      calls++;
      throw new ContextLengthExceededError("always-overflows", "maximum context length");
    },
  };
  const agent = new Agent({ llm, tools: [] });

  await assert.rejects(agent.run("hi"), ContextLengthExceededError);
  // A single short message can't be compacted, so there is nothing to retry
  // with — and a provider reporting an overflow for some other reason must
  // not drive an endless shrink loop.
  assert.ok(calls <= 2, `expected at most one retry, got ${calls} calls`);
});

test("emits a trace event when it compacts, so lost history isn't invisible", async () => {
  const events: { kind: string; droppedMessages?: number }[] = [];
  const agent = new Agent({
    llm: { name: "ok", chat: async () => ({ text: "ok", toolCalls: [], stop: true }) },
    tools: [],
    context: { maxInputTokens: 500, reserveTokens: 0, keepRecentMessages: 2 },
    trace: { emit: async (e) => void events.push(e) },
  });

  const history = Array.from({ length: 50 }, (_, i) => userMessage(`turn ${i} ` + "x".repeat(200)));
  await agent.run("go", {
    runId: "r1",
    session: { getItems: async () => history, addItems: async () => {}, clear: async () => {} },
  });

  const compaction = events.find((e) => e.kind === "context-compaction");
  // Without a record, the model quietly losing access to earlier turns is
  // indistinguishable from the model just being forgetful.
  assert.ok(compaction, "expected a context-compaction trace event");
  assert.ok((compaction.droppedMessages ?? 0) > 0);
});
