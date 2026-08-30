import { test } from "node:test";
import assert from "node:assert/strict";
import { createFallbackProvider } from "./providers/fallback.js";
import type { LLMProvider, LLMTurn } from "./types.js";

function fakeProvider(name: string, chat: LLMProvider["chat"], chatStream?: LLMProvider["chatStream"]): LLMProvider {
  return { name, chat, chatStream };
}

function alwaysSucceeds(name: string, turn: LLMTurn): LLMProvider {
  return fakeProvider(name, async () => turn);
}

function alwaysThrows(name: string, message: string): LLMProvider {
  return fakeProvider(name, async () => {
    throw new Error(message);
  });
}

const PARAMS = { system: undefined, messages: [], tools: [] };

test("throws immediately when given an empty provider list", () => {
  assert.throws(() => createFallbackProvider([]), /at least one provider/);
});

test("chat() uses the first provider when it succeeds, never touching the rest", async () => {
  let secondCalled = false;
  const first = alwaysSucceeds("first", { text: "from first", toolCalls: [], stop: true });
  const second = fakeProvider("second", async () => {
    secondCalled = true;
    return { text: "from second", toolCalls: [], stop: true };
  });

  const provider = createFallbackProvider([first, second]);
  const turn = await provider.chat(PARAMS);

  assert.equal(turn.text, "from first");
  assert.equal(secondCalled, false);
});

test("chat() falls through to the next provider when the first throws", async () => {
  const first = alwaysThrows("first", "rate limited");
  const second = alwaysSucceeds("second", { text: "from second", toolCalls: [], stop: true });

  const provider = createFallbackProvider([first, second]);
  const turn = await provider.chat(PARAMS);

  assert.equal(turn.text, "from second");
});

test("chat() falls through multiple failing providers before succeeding", async () => {
  const first = alwaysThrows("first", "down");
  const second = alwaysThrows("second", "also down");
  const third = alwaysSucceeds("third", { text: "from third", toolCalls: [], stop: true });

  const provider = createFallbackProvider([first, second, third]);
  const turn = await provider.chat(PARAMS);

  assert.equal(turn.text, "from third");
});

test("chat() propagates the last provider's error once every provider has failed", async () => {
  const first = alwaysThrows("first", "down");
  const second = alwaysThrows("second", "also down");

  const provider = createFallbackProvider([first, second]);

  await assert.rejects(() => provider.chat(PARAMS), /also down/);
});

test("onFallback fires once per failed provider, naming the failed and next provider, never for the last", async () => {
  const first = alwaysThrows("first", "down");
  const second = alwaysThrows("second", "also down");
  const third = alwaysSucceeds("third", { text: "ok", toolCalls: [], stop: true });
  const calls: { failed: string; next: string }[] = [];

  const provider = createFallbackProvider([first, second, third], {
    onFallback: (_err, failed, next) => calls.push({ failed: failed.name, next: next.name }),
  });
  await provider.chat(PARAMS);

  assert.deepEqual(calls, [
    { failed: "first", next: "second" },
    { failed: "second", next: "third" },
  ]);
});

test("name lists every provider in order", () => {
  const provider = createFallbackProvider([alwaysSucceeds("a", { toolCalls: [], stop: true }), alwaysSucceeds("b", { toolCalls: [], stop: true })]);
  assert.equal(provider.name, "fallback(a -> b)");
});

test("chatStream is present when every provider implements it, and falls through the same way chat() does", async () => {
  const seen: string[] = [];
  const first = fakeProvider(
    "first",
    async () => {
      throw new Error("unused");
    },
    async () => {
      throw new Error("stream down");
    },
  );
  const second = fakeProvider(
    "second",
    async () => {
      throw new Error("unused");
    },
    async (_params, onText) => {
      onText("hi");
      return { text: "hi", toolCalls: [], stop: true };
    },
  );

  const provider = createFallbackProvider([first, second]);
  assert.ok(provider.chatStream);
  const turn = await provider.chatStream!(PARAMS, (delta) => seen.push(delta));

  assert.deepEqual(seen, ["hi"]);
  assert.equal(turn.text, "hi");
});

test("chatStream is absent when any provider in the chain lacks it", () => {
  const first = alwaysSucceeds("first", { toolCalls: [], stop: true }); // no chatStream
  const second = fakeProvider(
    "second",
    async () => ({ toolCalls: [], stop: true }),
    async (_params, onText) => {
      onText("x");
      return { toolCalls: [], stop: true };
    },
  );

  const provider = createFallbackProvider([first, second]);
  assert.equal(provider.chatStream, undefined);
});
