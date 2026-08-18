import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BerthAgentError,
  ContextLengthExceededError,
  MaxTurnsExceededError,
  ProviderAuthError,
  ProviderError,
  ProviderRequestInvalidError,
  ProviderUnavailableError,
  RateLimitError,
  UnknownToolError,
  classifyProviderError,
  isAbortError,
  withProviderErrors,
  wrapProviderErrors,
} from "./errors.js";
import { createFallbackProvider } from "./providers/fallback.js";
import { Agent } from "./agent.js";
import type { LLMProvider, LLMTurn, Tool } from "./types.js";

/** A vendor SDK error: an Error carrying `status` and a header bag, which is the shape both the OpenAI and Anthropic clients throw. */
function vendorError(message: string, status?: number, headers?: Record<string, string>): Error {
  return Object.assign(new Error(message), { status, headers });
}

// ---------------------------------------------------------------------------
// classifyProviderError
// ---------------------------------------------------------------------------

test("classifies 429 as a retriable rate limit", () => {
  const err = classifyProviderError(vendorError("slow down", 429), "openai");
  assert.ok(err instanceof RateLimitError);
  assert.equal(err.retriable, true);
  assert.equal(err.code, "provider_rate_limited");
  assert.equal(err.provider, "openai");
  assert.equal(err.status, 429);
});

test("reads retry-after off a plain header bag and off a Headers-like object", () => {
  const plain = classifyProviderError(vendorError("slow down", 429, { "retry-after": "30" }), "openai");
  assert.equal((plain as RateLimitError).retryAfterMs, 30_000);

  const headersLike = Object.assign(new Error("slow down"), {
    status: 429,
    headers: { get: (name: string) => (name === "retry-after" ? "2" : null) },
  });
  assert.equal((classifyProviderError(headersLike, "anthropic") as RateLimitError).retryAfterMs, 2_000);
});

test("classifies a context-length overflow as NOT retriable, ahead of the generic 400 branch", () => {
  // The status here is 400, which the generic branch would call
  // ProviderRequestInvalidError. Context length has no distinct status code
  // at any vendor, so message matching has to win — this asserts the ordering
  // rather than trusting it.
  const err = classifyProviderError(
    vendorError("This model's maximum context length is 128000 tokens", 400),
    "openai",
  );
  assert.ok(err instanceof ContextLengthExceededError);
  assert.equal(err.retriable, false);
});

test("recognizes each vendor's context-length prose", () => {
  for (const message of [
    "context_length_exceeded",
    "prompt is too long: 250000 tokens > 200000 maximum",
    "Request too large for gpt-4o",
    "The input token count exceeds the maximum",
  ]) {
    assert.ok(
      classifyProviderError(vendorError(message, 400), "p") instanceof ContextLengthExceededError,
      `expected context-length classification for: ${message}`,
    );
  }
});

test("classifies 401/403 as auth, and marks it retriable so a fallback chain tries the next credential", () => {
  for (const status of [401, 403]) {
    const err = classifyProviderError(vendorError("invalid api key", status), "openai");
    assert.ok(err instanceof ProviderAuthError);
    // Reads backwards until you remember what `retriable` means here: not
    // "repeating this call helps" but "another provider is worth trying".
    // A fallback chain exists precisely for a dead key on provider A.
    assert.equal(err.retriable, true);
  }
});

test("classifies 5xx and transport failures as unavailable", () => {
  assert.ok(classifyProviderError(vendorError("bad gateway", 502), "p") instanceof ProviderUnavailableError);
  const econn = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  assert.ok(classifyProviderError(econn, "p") instanceof ProviderUnavailableError);
});

test("classifies a non-auth non-rate-limit 4xx as an invalid request, not retriable", () => {
  const err = classifyProviderError(vendorError("model `gpt-9` does not exist", 404), "openai");
  assert.ok(err instanceof ProviderRequestInvalidError);
  assert.equal(err.retriable, false);
});

test("an unrecognized error stays retriable, preserving pre-4.8 fallback behaviour", () => {
  // The whole safety property of adding classification: anything the
  // heuristics don't recognize behaves exactly as it did when there were no
  // heuristics. Classification can narrow what falls through, never widen it.
  const err = classifyProviderError(new Error("something nobody anticipated"), "p");
  assert.equal(err.constructor, ProviderError);
  assert.equal(err.retriable, true);
});

test("preserves the original error as cause, and is idempotent", () => {
  const original = vendorError("slow down", 429);
  const once = classifyProviderError(original, "openai");
  assert.equal(once.cause, original);
  // Wrapping an already-classified error must not bury the cause a level
  // deeper — a provider inside a fallback chain gets classified twice.
  assert.equal(classifyProviderError(once, "openai"), once);
});

test("every error in the taxonomy is a BerthAgentError with a stable code", () => {
  const errors: BerthAgentError[] = [
    new MaxTurnsExceededError("a", 5),
    new UnknownToolError("nope"),
    new RateLimitError("p", "m"),
    new ContextLengthExceededError("p", "m"),
  ];
  for (const err of errors) {
    assert.ok(err instanceof BerthAgentError);
    assert.ok(err instanceof Error);
    // The name has to survive, or a log line reads "Error" for all of them.
    assert.equal(err.name, err.constructor.name);
    assert.equal(typeof err.code, "string");
  }
});

// ---------------------------------------------------------------------------
// isAbortError / withProviderErrors
// ---------------------------------------------------------------------------

test("recognizes every shape a cancellation arrives in", () => {
  assert.ok(isAbortError(Object.assign(new Error("aborted"), { name: "AbortError" })));
  assert.ok(isAbortError(Object.assign(new Error("aborted"), { name: "APIUserAbortError" })));
  assert.ok(isAbortError(Object.assign(new Error("aborted"), { code: "ABORT_ERR" })));
  assert.ok(!isAbortError(new Error("aborted")));
  assert.ok(!isAbortError(null));
});

test("withProviderErrors re-throws a cancellation unclassified", async () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  await assert.rejects(
    withProviderErrors("p", async () => {
      throw abort;
    }),
    (err: unknown) => err === abort,
  );
});

test("wrapProviderErrors leaves chatStream absent when the provider has none", () => {
  const bare: LLMProvider = { name: "bare", chat: async () => ({ toolCalls: [], stop: true }) };
  // A defined-but-throwing chatStream would turn a supported provider into a
  // broken one: Agent reads its presence as "this provider streams".
  assert.equal(wrapProviderErrors(bare).chatStream, undefined);
  const streaming: LLMProvider = { ...bare, chatStream: async () => ({ toolCalls: [], stop: true }) };
  assert.equal(typeof wrapProviderErrors(streaming).chatStream, "function");
});

test("wrapProviderErrors classifies what the wrapped provider throws", async () => {
  const provider = wrapProviderErrors({
    name: "openai",
    chat: async () => {
      throw vendorError("rate limit reached", 429);
    },
  });
  await assert.rejects(provider.chat({ messages: [], tools: [] }), (err: unknown) => err instanceof RateLimitError);
});

// ---------------------------------------------------------------------------
// The behaviour change this taxonomy exists for: fallback classification
// ---------------------------------------------------------------------------

function throwingProvider(name: string, err: unknown): LLMProvider {
  return {
    name,
    chat: async () => {
      throw err;
    },
  };
}

function succeedingProvider(name: string, turn: LLMTurn, onCall: () => void = () => {}): LLMProvider {
  return {
    name,
    chat: async () => {
      onCall();
      return turn;
    },
  };
}

const PARAMS = { messages: [], tools: [] };

test("falls through on a retriable provider error", async () => {
  const chain = createFallbackProvider([
    throwingProvider("first", new RateLimitError("first", "slow down")),
    succeedingProvider("second", { text: "ok", toolCalls: [], stop: true }),
  ]);
  assert.equal((await chain.chat(PARAMS)).text, "ok");
});

test("does NOT fall through on an invalid request — every provider would reject it identically", async () => {
  let secondCalled = false;
  const chain = createFallbackProvider([
    throwingProvider("first", new ProviderRequestInvalidError("first", "model `gpt-9` does not exist")),
    succeedingProvider("second", { text: "ok", toolCalls: [], stop: true }, () => {
      secondCalled = true;
    }),
  ]);

  await assert.rejects(chain.chat(PARAMS), (err: unknown) => err instanceof ProviderRequestInvalidError);
  // The point of the classification: the caller gets the *first* provider's
  // clear message immediately, instead of N round trips ending in the last
  // provider's version of the same complaint.
  assert.equal(secondCalled, false);
});

test("does NOT fall through on a context-length overflow", async () => {
  let secondCalled = false;
  const chain = createFallbackProvider([
    throwingProvider("first", new ContextLengthExceededError("first", "maximum context length")),
    succeedingProvider("second", { text: "ok", toolCalls: [], stop: true }, () => {
      secondCalled = true;
    }),
  ]);
  await assert.rejects(chain.chat(PARAMS), (err: unknown) => err instanceof ContextLengthExceededError);
  assert.equal(secondCalled, false);
});

test("never falls through on a cancellation, even with a shouldFallThrough that says everything retries", async () => {
  let secondCalled = false;
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  const chain = createFallbackProvider(
    [
      throwingProvider("first", abort),
      succeedingProvider("second", { text: "ok", toolCalls: [], stop: true }, () => {
        secondCalled = true;
      }),
    ],
    { shouldFallThrough: () => true },
  );

  await assert.rejects(chain.chat(PARAMS), (err: unknown) => err === abort);
  // Honouring the override here would mean abort() starts a fresh request on
  // the next provider — the opposite of what cancelling means.
  assert.equal(secondCalled, false);
});

test("an unclassified error still falls through — the pre-4.8 contract", async () => {
  const chain = createFallbackProvider([
    throwingProvider("first", new Error("something nobody anticipated")),
    succeedingProvider("second", { text: "ok", toolCalls: [], stop: true }),
  ]);
  assert.equal((await chain.chat(PARAMS)).text, "ok");
});

test("onFallback does not fire for an error the chain refuses to fall through on", async () => {
  let fired = false;
  const chain = createFallbackProvider(
    [
      throwingProvider("first", new ProviderRequestInvalidError("first", "bad request")),
      succeedingProvider("second", { text: "ok", toolCalls: [], stop: true }),
    ],
    {
      onFallback: () => {
        fired = true;
      },
    },
  );
  await assert.rejects(chain.chat(PARAMS));
  assert.equal(fired, false);
});

// ---------------------------------------------------------------------------
// Loop errors, through a real Agent
// ---------------------------------------------------------------------------

function toolNamed(name: string): Tool {
  return { name, description: name, inputSchema: { type: "object" }, invoke: async () => "done" };
}

test("MaxTurnsExceededError carries the tool calls the run did complete", async () => {
  // The bare Error this replaces discarded them, so a caller had no way to
  // salvage or even inspect a run that ran long.
  const llm: LLMProvider = {
    name: "loop-forever",
    chat: async () => ({
      text: "still working",
      toolCalls: [{ id: "1", name: "ping", input: {} }],
      stop: false,
    }),
  };
  const agent = new Agent({ name: "looper", llm, tools: [toolNamed("ping")], maxTurns: 3 });

  await assert.rejects(agent.run("go"), (err: unknown) => {
    assert.ok(err instanceof MaxTurnsExceededError);
    assert.equal(err.code, "max_turns_exceeded");
    assert.equal(err.agentName, "looper");
    assert.equal(err.maxTurns, 3);
    assert.equal(err.toolCalls.length, 3);
    assert.equal(err.partialText, "still working");
    return true;
  });
});

test("an unknown tool is reported to the model with the list of tools that do exist", async () => {
  let sawToolResult: unknown;
  let turn = 0;
  const llm: LLMProvider = {
    name: "asks-for-a-ghost",
    chat: async ({ messages }) => {
      if (turn++ === 0) return { toolCalls: [{ id: "1", name: "ghost", input: {} }], stop: false };
      sawToolResult = messages.find((m) => m.role === "tool")?.toolResult?.output;
      return { text: "gave up", toolCalls: [], stop: true };
    },
  };
  const agent = new Agent({ llm, tools: [toolNamed("read_file"), toolNamed("write_file")] });

  const result = await agent.run("go");

  // Still fed back rather than thrown: guessing a tool name is a mistake the
  // model can correct on the next turn, and killing the run would regress.
  assert.equal(result.text, "gave up");
  const error = (sawToolResult as { error: string }).error;
  assert.match(error, /no such tool "ghost"/);
  assert.match(error, /read_file, write_file/);
});

test("resume() distinguishes a missing store from a missing run", async () => {
  const llm: LLMProvider = { name: "unused", chat: async () => ({ toolCalls: [], stop: true }) };

  const noStore = new Agent({ name: "a", llm, tools: [] });
  await assert.rejects(noStore.resume("r1"), (err: unknown) => {
    assert.ok(err instanceof BerthAgentError);
    assert.equal(err.code, "checkpoint_store_missing");
    return true;
  });

  const withStore = new Agent({
    name: "a",
    llm,
    tools: [],
    checkpoint: { save: async () => {}, load: async () => null },
  });
  await assert.rejects(withStore.resume("r1"), (err: unknown) => {
    assert.ok(err instanceof BerthAgentError);
    // A different code, because "you never configured this" and "that run
    // isn't here" call for different responses from a caller.
    assert.equal(err.code, "checkpoint_not_found");
    return true;
  });
});
