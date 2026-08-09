import { test } from "node:test";
import assert from "node:assert/strict";
import { createAnthropicProvider } from "./anthropic.js";
import { startMockLLMServer, anthropicMessage } from "./mock-server.js";
import type { AgentMessage } from "../types.js";

function provider(url: string) {
  return createAnthropicProvider({ apiKey: "test-key", baseURL: url, maxRetries: 0 });
}

async function sentBody(messages: AgentMessage[]) {
  const server = await startMockLLMServer();
  try {
    server.respondWith(anthropicMessage());
    await provider(server.url).chat({ messages, tools: [] });
    return server.onlyRequest().body;
  } finally {
    await server.close();
  }
}

/**
 * REMEDIATION 3.6. The Messages API rejects a message whose content is an
 * empty array or an empty string — "all messages must have non-empty
 * content". Both shapes were reachable from Agent.run():
 *
 *  - `content: []` for an assistant turn carrying neither text nor tool calls
 *  - `content: ""` for a user message with no text, which the responseSchema
 *    repair path can push directly (agent.ts pushes {role:"assistant", text:""})
 *
 * The fix drops such messages rather than sending a placeholder: a turn with
 * nothing in it carries no information, and inventing filler text would put
 * words in the model's mouth that it never said.
 */
test("an assistant message with neither text nor tool calls is dropped, not sent empty", async () => {
  const body = await sentBody([
    { role: "user", text: "hi" },
    { role: "assistant", text: "" },
    { role: "user", text: "still there?" },
  ]);

  assert.equal(body.messages.length, 2, `expected the empty assistant turn to be dropped, got ${JSON.stringify(body.messages)}`);
  assert.deepEqual(
    body.messages.map((m: any) => m.role),
    ["user", "user"],
  );
});

test("a user message with empty text is dropped, not sent as an empty string", async () => {
  const body = await sentBody([
    { role: "user", text: "hi" },
    { role: "user", text: "" },
  ]);

  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].content, "hi");
});

test("no message is ever sent with empty content", async () => {
  const body = await sentBody([
    { role: "user", text: "" },
    { role: "assistant", text: undefined },
    { role: "user", text: "the only real one" },
  ]);

  for (const message of body.messages) {
    const empty = message.content === "" || (Array.isArray(message.content) && message.content.length === 0);
    assert.equal(empty, false, `message with empty content reached the wire: ${JSON.stringify(message)}`);
  }
  assert.equal(body.messages.length, 1);
});

/**
 * The positive control, and it matters more than usual here: every assertion
 * above would also pass against an adapter that dropped *every* message.
 */
test("messages with real content are still sent, in order and unchanged", async () => {
  const body = await sentBody([
    { role: "user", text: "first" },
    { role: "assistant", text: "second" },
    { role: "user", text: "third" },
  ]);

  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[0].content, "first");
  assert.deepEqual(body.messages[1].content, [{ type: "text", text: "second" }]);
  assert.equal(body.messages[2].content, "third");
});

/**
 * An assistant turn with tool calls but no text is legitimate and common —
 * the model deciding to act without narrating. Dropping it would break every
 * tool-use loop, so the guard has to key on "no content at all", not "no
 * text".
 */
test("an assistant turn with tool calls but no text is preserved", async () => {
  const body = await sentBody([
    { role: "user", text: "run it" },
    { role: "assistant", text: undefined, toolCalls: [{ id: "t1", name: "echo", input: { a: 1 } }] },
    { role: "tool", toolResult: { id: "t1", name: "echo", output: { a: 1 } } },
  ]);

  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[1].content.length, 1);
  assert.equal(body.messages[1].content[0].type, "tool_use");
  assert.equal(body.messages[1].content[0].name, "echo");
});

/**
 * A tool result must be non-empty *and* parseable. `JSON.stringify(undefined)`
 * returns undefined rather than a string, so an export returning nothing used
 * to put the bare token `undefined` on the wire — not valid JSON, and the
 * model reads it as a word. openai.ts already normalized this with `?? null`;
 * this adapter didn't.
 */
test("a tool result with an empty output still carries non-empty, parseable content", async () => {
  const body = await sentBody([
    { role: "user", text: "run it" },
    { role: "assistant", text: undefined, toolCalls: [{ id: "t1", name: "noop", input: {} }] },
    { role: "tool", toolResult: { id: "t1", name: "noop", output: undefined } },
  ]);

  const toolMessage = body.messages[2];
  assert.equal(toolMessage.content[0].type, "tool_result");
  assert.notEqual(toolMessage.content[0].content, "");
  assert.equal(JSON.parse(toolMessage.content[0].content), null);
});
