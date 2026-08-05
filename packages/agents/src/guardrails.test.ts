import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runGuardrails,
  createKeywordGuardrail,
  createRegexGuardrail,
  createLlmGuardrail,
  GuardrailTripwireError,
} from "./guardrails.js";
import type { LLMProvider } from "./types.js";

test("runGuardrails does nothing when every guardrail passes", async () => {
  await runGuardrails(
    [() => ({ tripwireTriggered: false }), () => ({ tripwireTriggered: false })],
    "harmless text",
    "input",
  );
});

test("runGuardrails throws a GuardrailTripwireError carrying the stage and message", async () => {
  await assert.rejects(
    () => runGuardrails([() => ({ tripwireTriggered: true, message: "nope" })], "text", "output"),
    (err: unknown) => {
      assert.ok(err instanceof GuardrailTripwireError);
      assert.equal(err.stage, "output");
      assert.equal(err.guardrailMessage, "nope");
      return true;
    },
  );
});

test("a tripped guardrail with no message still throws a usable error", async () => {
  await assert.rejects(
    () => runGuardrails([() => ({ tripwireTriggered: true })], "text", "input"),
    /no reason given/,
  );
});

test("createKeywordGuardrail trips on a case-insensitive substring match by default", () => {
  const guardrail = createKeywordGuardrail(["forbidden"]);
  const result = guardrail("this text is FORBIDDEN here") as { tripwireTriggered: boolean; message?: string };
  assert.equal(result.tripwireTriggered, true);
  assert.match(result.message!, /forbidden/);
});

test("createKeywordGuardrail does not trip when caseSensitive is set and the case differs", () => {
  const guardrail = createKeywordGuardrail(["forbidden"], { caseSensitive: true });
  const result = guardrail("this text is FORBIDDEN here") as { tripwireTriggered: boolean };
  assert.equal(result.tripwireTriggered, false);
});

test("createKeywordGuardrail passes clean text", () => {
  const guardrail = createKeywordGuardrail(["forbidden"]);
  const result = guardrail("this text is fine") as { tripwireTriggered: boolean };
  assert.equal(result.tripwireTriggered, false);
});

test("createRegexGuardrail trips on a pattern match with a custom message", () => {
  const guardrail = createRegexGuardrail(/\d{3}-\d{2}-\d{4}/, "looked like an SSN");
  const result = guardrail("my number is 123-45-6789") as { tripwireTriggered: boolean; message?: string };
  assert.equal(result.tripwireTriggered, true);
  assert.equal(result.message, "looked like an SSN");
});

test("createRegexGuardrail passes text that doesn't match", () => {
  const guardrail = createRegexGuardrail(/\d{3}-\d{2}-\d{4}/);
  const result = guardrail("no numbers here") as { tripwireTriggered: boolean };
  assert.equal(result.tripwireTriggered, false);
});

function fakeJudge(responseText: string): LLMProvider {
  return {
    name: "fake-judge",
    async chat() {
      return { text: responseText, toolCalls: [], stop: true };
    },
  };
}

test("createLlmGuardrail trips when the judge says so", async () => {
  const guardrail = createLlmGuardrail({
    judge: fakeJudge('{"tripwireTriggered": true, "reason": "violates rubric"}'),
    rubric: "no profanity",
  });
  const result = await guardrail("some text");
  assert.equal(result.tripwireTriggered, true);
  assert.equal(result.message, "violates rubric");
});

test("createLlmGuardrail passes when the judge says so", async () => {
  const guardrail = createLlmGuardrail({
    judge: fakeJudge('{"tripwireTriggered": false, "reason": "looks fine"}'),
    rubric: "no profanity",
  });
  const result = await guardrail("some text");
  assert.equal(result.tripwireTriggered, false);
});

test("createLlmGuardrail fails closed (trips) when the judge's response can't be parsed", async () => {
  const guardrail = createLlmGuardrail({
    judge: fakeJudge("not json at all"),
    rubric: "no profanity",
  });
  const result = await guardrail("some text");
  assert.equal(result.tripwireTriggered, true);
  assert.match(result.message!, /could not be parsed/);
});
