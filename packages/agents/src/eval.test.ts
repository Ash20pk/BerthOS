import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runEvalSuite,
  containsText,
  matchesPattern,
  calledTool,
  llmJudge,
  type EvalRunnable,
  type EvalCase,
} from "./eval.js";
import type { AgentRunResult } from "./agent.js";
import type { LLMProvider } from "./types.js";

function scriptedRunnable(byInput: Record<string, AgentRunResult | Error>): EvalRunnable {
  return {
    async run(input: string) {
      const scripted = byInput[input];
      if (scripted === undefined) throw new Error(`no scripted result for input "${input}"`);
      if (scripted instanceof Error) throw scripted;
      return scripted;
    },
  };
}

function result(text: string, toolCalls: AgentRunResult["toolCalls"] = []): AgentRunResult {
  return { text, toolCalls };
}

test("containsText() passes when the substring is present, fails with a clear message otherwise", async () => {
  const pass = await containsText("hello")(result("hello, world"));
  assert.deepEqual(pass, { pass: true, message: 'contains "hello"' });

  const fail = await containsText("goodbye")(result("hello, world"));
  assert.equal(fail.pass, false);
  assert.match(fail.message, /goodbye/);
});

test("matchesPattern() passes when the regex matches", async () => {
  const pass = await matchesPattern(/^\d+$/)(result("42"));
  assert.equal(pass.pass, true);

  const fail = await matchesPattern(/^\d+$/)(result("not a number"));
  assert.equal(fail.pass, false);
});

test("calledTool() checks the tool-call list, not the text", async () => {
  const withCall = result("done", [{ name: "search", input: {}, result: "ok" }]);
  assert.equal((await calledTool("search")(withCall)).pass, true);
  assert.equal((await calledTool("other")(withCall)).pass, false);

  const withoutCalls = result("done");
  const fail = await calledTool("search")(withoutCalls);
  assert.equal(fail.pass, false);
  assert.match(fail.message, /\(none\)/);
});

test("runEvalSuite() reports pass/fail per case and a suite-level summary", async () => {
  const runnable = scriptedRunnable({
    "say hello": result("hello there"),
    "say goodbye": result("hello there"), // wrong response on purpose
  });

  const cases: EvalCase[] = [
    { name: "greets", input: "say hello", assertions: [containsText("hello")] },
    { name: "says goodbye", input: "say goodbye", assertions: [containsText("goodbye")] },
  ];

  const suite = await runEvalSuite(runnable, cases);

  assert.equal(suite.total, 2);
  assert.equal(suite.passed, 1);
  assert.equal(suite.failed, 1);
  assert.equal(suite.results[0]!.passed, true);
  assert.equal(suite.results[1]!.passed, false);
  assert.equal(suite.results[1]!.assertionResults[0]!.pass, false);
});

test("runEvalSuite() marks a case failed (with the error message) when the run itself throws, without stopping other cases", async () => {
  const runnable = scriptedRunnable({
    "will crash": new Error("exceeded maxTurns"),
    "will pass": result("fine"),
  });

  const cases: EvalCase[] = [
    { name: "crashes", input: "will crash", assertions: [containsText("anything")] },
    { name: "passes", input: "will pass", assertions: [containsText("fine")] },
  ];

  const suite = await runEvalSuite(runnable, cases);

  assert.equal(suite.total, 2);
  assert.equal(suite.results[0]!.passed, false);
  assert.equal(suite.results[0]!.error, "exceeded maxTurns");
  assert.deepEqual(suite.results[0]!.assertionResults, []);
  assert.equal(suite.results[1]!.passed, true, "the crashing case doesn't stop the next one from running");
});

test("runEvalSuite() requires every assertion in a case to pass", async () => {
  const runnable = scriptedRunnable({ input: result("hello world") });
  const cases: EvalCase[] = [
    { name: "both", input: "input", assertions: [containsText("hello"), containsText("goodbye")] },
  ];

  const suite = await runEvalSuite(runnable, cases);
  assert.equal(suite.results[0]!.passed, false);
  assert.equal(suite.results[0]!.assertionResults.length, 2);
});

function fakeJudge(responseText: string): LLMProvider {
  return {
    name: "fake-judge",
    async chat() {
      return { text: responseText, toolCalls: [], stop: true };
    },
  };
}

test("llmJudge() passes when the judge returns a parseable {pass: true} verdict", async () => {
  const judge = fakeJudge('{"pass": true, "reason": "meets the rubric"}');
  const assertion = llmJudge({ judge, rubric: "must be polite" });

  const verdict = await assertion(result("hi there, happy to help!"));
  assert.deepEqual(verdict, { pass: true, message: "meets the rubric" });
});

test("llmJudge() fails when the judge returns a parseable {pass: false} verdict", async () => {
  const judge = fakeJudge('{"pass": false, "reason": "too rude"}');
  const assertion = llmJudge({ judge, rubric: "must be polite" });

  const verdict = await assertion(result("get lost"));
  assert.deepEqual(verdict, { pass: false, message: "too rude" });
});

test("llmJudge() fails (rather than throwing) when the judge's response isn't a parseable verdict", async () => {
  const judge = fakeJudge("not json at all");
  const assertion = llmJudge({ judge, rubric: "must be polite" });

  const verdict = await assertion(result("hi there"));
  assert.equal(verdict.pass, false);
  assert.match(verdict.message, /could not be parsed/);
});

test("llmJudge() includes the rubric and the agent's response text in the prompt sent to the judge", async () => {
  let capturedPrompt = "";
  const judge: LLMProvider = {
    name: "fake-judge",
    async chat(params) {
      capturedPrompt = params.messages[0]!.text ?? "";
      return { text: '{"pass": true, "reason": "ok"}', toolCalls: [], stop: true };
    },
  };

  await llmJudge({ judge, rubric: "must mention pricing" })(result("our pricing starts at $10/mo"));

  assert.match(capturedPrompt, /must mention pricing/);
  assert.match(capturedPrompt, /\$10\/mo/);
});
