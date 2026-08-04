import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.js";
import { Crew } from "./crew.js";
import type { LLMProvider, LLMTurn } from "./types.js";

function scriptedLLM(turns: LLMTurn[]): LLMProvider {
  let i = 0;
  return {
    name: "fake",
    async chat() {
      const turn = turns[i];
      if (!turn) throw new Error("script exhausted — llm.chat() called more times than the test expected");
      i++;
      return turn;
    },
  };
}

function textAgent(name: string, text: string): Agent {
  return new Agent({ name, llm: scriptedLLM([{ text, toolCalls: [], stop: true }]), tools: [] });
}

test("Crew.parallel runs every agent against the same input and merges with the default merge", async () => {
  const crew = Crew.parallel([textAgent("a", "output-a"), textAgent("b", "output-b")]);

  const result = await crew.run("shared input");

  assert.match(result, /## a\noutput-a/);
  assert.match(result, /## b\noutput-b/);
});

test("Crew.parallel uses a custom merge function when given one", async () => {
  const crew = Crew.parallel([textAgent("a", "output-a"), textAgent("b", "output-b")], {
    merge: (results) => results.map((r) => r.text).join("|"),
  });

  const result = await crew.run("shared input");

  assert.equal(result, "output-a|output-b");
});

test("Crew.loopUntil stops as soon as until() returns true, feeding output back in as input", async () => {
  let calls = 0;
  const agent = new Agent({
    llm: {
      name: "fake",
      async chat(params) {
        calls++;
        const lastUserText = params.messages.at(-1)?.text ?? "";
        return { text: `${lastUserText}!`, toolCalls: [], stop: true };
      },
    },
    tools: [],
  });

  const crew = Crew.loopUntil({
    agent,
    until: (result) => result === "seed!!!",
  });

  const result = await crew.run("seed");

  assert.equal(result, "seed!!!");
  assert.equal(calls, 3, "one call per '!' appended, stopping the run it first satisfies until()");
});

test("Crew.loopUntil stops at maxIterations if until() never returns true", async () => {
  const agent = new Agent({
    llm: {
      name: "fake",
      async chat() {
        return { text: "never satisfied", toolCalls: [], stop: true };
      },
    },
    tools: [],
  });
  let untilCalls = 0;

  const crew = Crew.loopUntil({ agent, until: () => (untilCalls++, false), maxIterations: 3 });
  const result = await crew.run("seed");

  assert.equal(result, "never satisfied");
  assert.equal(untilCalls, 3);
});

test("Crew.route dispatches to the branch matching the router's answer, run against the original input", async () => {
  const router = textAgent("router", "billing");
  const billing = textAgent("billing-agent", "handled by billing");
  const support = textAgent("support-agent", "handled by support");

  const crew = Crew.route({ router, routes: { billing, support } });
  const result = await crew.run("where's my refund?");

  assert.equal(result, "handled by billing");
});

test("Crew.route falls back to fallback when the router's answer matches no route", async () => {
  const router = textAgent("router", "something unexpected");
  const billing = textAgent("billing-agent", "handled by billing");
  const fallback = textAgent("fallback-agent", "handled by fallback");

  const crew = Crew.route({ router, routes: { billing }, fallback });
  const result = await crew.run("???");

  assert.equal(result, "handled by fallback");
});

test("Crew.route throws, naming the router's answer, when no route matches and no fallback is given", async () => {
  const router = textAgent("router", "something unexpected");
  const billing = textAgent("billing-agent", "handled by billing");

  const crew = Crew.route({ router, routes: { billing } });

  await assert.rejects(() => crew.run("???"), /something unexpected/);
});
