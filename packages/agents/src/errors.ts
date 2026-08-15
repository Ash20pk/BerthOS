/**
 * The agent loop's error taxonomy — REMEDIATION 4.8.
 *
 * Typed errors existed only at the edges before this (StructuredOutputError,
 * GuardrailTripwireError, GovernanceDeniedError, HumanApprovalDeniedError,
 * TruncatedResponseError, CheckpointReadError). Everything the *core loop*
 * itself raised was a bare `Error` distinguishable only by matching on its
 * message: exceeding maxTurns, resuming without a checkpoint store, resuming
 * a runId that has no checkpoint, calling a tool that doesn't exist.
 *
 * That absence had a concrete cost beyond ergonomics, and it's the reason this
 * file exists rather than being a tidying pass. `createFallbackProvider()`
 * fell through to the next provider on *any* thrown error, because it had no
 * way to tell one kind from another. So a malformed request (every provider
 * in the chain will reject it identically) burned the whole chain, and — once
 * REMEDIATION 4.2 lands — a caller's own `abort()` would have been treated as
 * a provider outage and retried against the next one, which is the opposite of
 * what cancelling means.
 *
 * Two families live here:
 *
 * - **Loop errors** (`MaxTurnsExceededError`, `UnknownToolError`, the two
 *   checkpoint ones) — raised by this package about its own operation.
 * - **Provider errors** (`ProviderError` and its five subclasses) — a vendor
 *   SDK's failure, classified into the handful of categories a caller can
 *   actually act on differently. `classifyProviderError()` does the mapping;
 *   every built-in provider routes its calls through `withProviderErrors()`.
 *
 * Every class here extends `BerthAgentError`, so `err instanceof
 * BerthAgentError` distinguishes "this package raised this deliberately" from
 * a `TypeError` out of a bug. The `code` field is the same information as a
 * stable string, for callers crossing a process boundary (an HTTP surface, a
 * log sink) where `instanceof` doesn't survive.
 */

import type { LLMProvider } from "./types.js";

/** Stable, serializable discriminators. Chosen so a log sink or an HTTP surface can switch on them without importing this package. */
export type BerthAgentErrorCode =
  | "max_turns_exceeded"
  | "unknown_tool"
  | "checkpoint_not_found"
  | "checkpoint_store_missing"
  | "provider_rate_limited"
  | "provider_context_length_exceeded"
  | "provider_auth_failed"
  | "provider_unavailable"
  | "provider_request_invalid"
  | "provider_error";

/**
 * Base class for every error this package raises deliberately.
 *
 * Note what is deliberately *not* re-parented onto this: the pre-existing
 * edge errors (StructuredOutputError, GuardrailTripwireError,
 * HumanApprovalDeniedError, GovernanceDeniedError, TruncatedResponseError,
 * CheckpointReadError) keep extending `Error` directly. Re-parenting them
 * would be a breaking change for anyone whose `catch` narrows on them today,
 * for no benefit — they are already typed, already exported, and already
 * distinguishable. This class exists for the errors that had *no* type at all.
 */
export class BerthAgentError extends Error {
  constructor(
    message: string,
    readonly code: BerthAgentErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
  }
}

/**
 * The tool-use loop hit its `maxTurns` ceiling without the model producing a
 * final answer. Carries the work done so far: a caller that wants to salvage
 * a partial run (or decide whether to re-run with a higher ceiling) needs the
 * tool calls that did execute, and previously had no way to reach them —
 * the bare Error at agent.ts:392 discarded them entirely.
 */
export class MaxTurnsExceededError extends BerthAgentError {
  constructor(
    readonly agentName: string,
    readonly maxTurns: number,
    readonly toolCalls: { name: string; input: unknown; result: unknown }[] = [],
    readonly partialText?: string,
  ) {
    super(
      `Agent "${agentName}" exceeded its maxTurns (${maxTurns}) without reaching a final answer. ` +
        `It made ${toolCalls.length} tool call(s). Raise maxTurns, or narrow the task.`,
      "max_turns_exceeded",
    );
  }
}

/**
 * The model asked for a tool this agent doesn't hold.
 *
 * This one is constructed but, by default, **not thrown** — `Agent`'s loop
 * feeds its `.message` back to the model as a tool result so it can pick a
 * real tool instead, which is the long-standing (and correct) behaviour. The
 * class exists so that message has one definition rather than being built
 * inline, and so a caller wrapping `Tool.invoke` themselves has something
 * typed to throw. `availableTools` is on it because "no such tool X" without
 * the list is the least actionable message a model can be handed.
 */
export class UnknownToolError extends BerthAgentError {
  constructor(
    readonly toolName: string,
    readonly availableTools: string[] = [],
  ) {
    super(
      availableTools.length > 0
        ? `no such tool "${toolName}" — available: ${availableTools.join(", ")}`
        : `no such tool "${toolName}"`,
      "unknown_tool",
    );
  }
}

/** `resume(runId)` found no checkpoint under that id. Distinct from CheckpointReadError, which is a *failed read* — see REMEDIATION 3.5, where conflating the two silently restarted runs from scratch. */
export class CheckpointNotFoundError extends BerthAgentError {
  constructor(readonly runId: string) {
    super(`no checkpoint found for run "${runId}"`, "checkpoint_not_found");
  }
}

/** `resume()` called on an Agent constructed without a `checkpoint` store. A configuration mistake, not a runtime failure — separate code so a caller can tell "you never set this up" from "the run isn't there". */
export class CheckpointStoreMissingError extends BerthAgentError {
  constructor(readonly agentName: string) {
    super(
      `Agent "${agentName}" has no checkpoint store configured — pass { checkpoint } when constructing it to resume a run`,
      "checkpoint_store_missing",
    );
  }
}

// ---------------------------------------------------------------------------
// Provider errors
// ---------------------------------------------------------------------------

/**
 * A vendor SDK call failed. Always carries the original error as `cause` —
 * classification is a convenience layered over the vendor's own error, never
 * a replacement for it, and anything this file's heuristics get wrong stays
 * recoverable from `cause`.
 *
 * `retriable` answers one question and only one: *is trying again, or trying
 * a different provider, plausibly useful?* It is not a promise that a retry
 * will succeed.
 */
export class ProviderError extends BerthAgentError {
  constructor(
    message: string,
    code: BerthAgentErrorCode,
    readonly provider: string,
    readonly retriable: boolean,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message, code, options);
    this.status = options?.status;
  }
  /** HTTP status from the vendor response, when there was one. */
  readonly status: number | undefined;
}

/** 429, or a vendor-specific quota message. Retriable: the canonical case for falling through to another provider. */
export class RateLimitError extends ProviderError {
  constructor(
    provider: string,
    message: string,
    options?: { cause?: unknown; status?: number; retryAfterMs?: number },
  ) {
    super(message, "provider_rate_limited", provider, true, options);
    this.retryAfterMs = options?.retryAfterMs;
  }
  /** From the `retry-after` header when the vendor sent one, in milliseconds. Absent, not zero, when it didn't. */
  readonly retryAfterMs: number | undefined;
}

/**
 * The request exceeded the model's context window.
 *
 * Marked **not** retriable, which is the interesting call. Re-sending the
 * identical oversized payload — to this provider or the next one in a
 * fallback chain — fails the same way, so treating it as retriable burns the
 * whole chain to arrive at the same error several seconds later. The useful
 * response is to make the payload smaller, which is exactly what REMEDIATION
 * 4.1's trim-and-retry does: it catches *this class specifically*, which is
 * why the two items landed adjacent to each other.
 */
export class ContextLengthExceededError extends ProviderError {
  constructor(provider: string, message: string, options?: { cause?: unknown; status?: number }) {
    super(message, "provider_context_length_exceeded", provider, false, options);
  }
}

/**
 * 401/403 — a missing, invalid, or unauthorized credential.
 *
 * Marked **retriable**, which reads wrong at first glance and is deliberate:
 * `retriable` here means "is another provider worth trying", not "will the
 * same call work if repeated". A fallback chain exists precisely so that a
 * bad or expired key on provider A hands off to provider B, which has an
 * entirely different credential. Retrying *A* is pointless; the SDK's own
 * retry layer already knows not to, since it never retries a 401.
 */
export class ProviderAuthError extends ProviderError {
  constructor(provider: string, message: string, options?: { cause?: unknown; status?: number }) {
    super(message, "provider_auth_failed", provider, true, options);
  }
}

/** 5xx, an overloaded signal, or a connection/timeout failure. Retriable. */
export class ProviderUnavailableError extends ProviderError {
  constructor(provider: string, message: string, options?: { cause?: unknown; status?: number }) {
    super(message, "provider_unavailable", provider, true, options);
  }
}

/**
 * A 4xx that isn't auth, rate limiting, or context length — a malformed
 * request, an unknown model, an unsupported parameter.
 *
 * Not retriable, and this is the classification that changes `createFallbackProvider()`'s
 * behaviour most visibly: the request this package built is wrong, so every
 * provider in the chain will reject it the same way. Falling through turns one
 * clear error into N slow ones and reports the *last* provider's message,
 * which is rarely the clearest.
 */
export class ProviderRequestInvalidError extends ProviderError {
  constructor(provider: string, message: string, options?: { cause?: unknown; status?: number }) {
    super(message, "provider_request_invalid", provider, false, options);
  }
}

/** Reads a `retry-after` header (seconds, or an HTTP date) off whatever header bag a vendor SDK exposes. */
function retryAfterMs(err: Record<string, unknown>): number | undefined {
  const headers = err.headers as undefined | Record<string, string> | { get(name: string): string | null };
  if (!headers) return undefined;
  const raw =
    typeof (headers as { get?: unknown }).get === "function"
      ? (headers as { get(name: string): string | null }).get("retry-after")
      : (headers as Record<string, string>)["retry-after"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Message fragments that mean "context window exceeded" across vendors. There
 * is no status code for this — OpenAI returns 400 with `code:
 * "context_length_exceeded"`, Anthropic returns 400 with prose, Gemini
 * returns 400 mentioning token counts — so message matching is the only
 * mechanism available, and it is matched *before* the generic 400 branch.
 *
 * Getting this wrong in the false-negative direction costs a trim-and-retry
 * that doesn't happen (the pre-4.1 behaviour, so no regression); in the
 * false-positive direction it costs a wasted trim on a request that was
 * merely malformed. Both are recoverable, which is why prose matching is
 * acceptable here and isn't elsewhere in this repo.
 */
const CONTEXT_LENGTH_PATTERNS = [
  "context_length_exceeded",
  "context length exceeded",
  "maximum context length",
  "too many tokens",
  "prompt is too long",
  "input is too long",
  "exceeds the maximum",
  "reduce the length",
  "request too large",
];

const RATE_LIMIT_PATTERNS = ["rate limit", "rate_limit", "quota", "too many requests", "overloaded"];

/**
 * Maps a thrown vendor error onto this file's taxonomy.
 *
 * Status code first, since every major SDK surfaces one and it's the only
 * signal that isn't prose. Message matching is the fallback for the cases
 * with no distinct code (context length) and for transport-level failures
 * that never reached HTTP at all.
 *
 * An error that matches nothing becomes a `ProviderError` with
 * `retriable: true`. That default is deliberate: it preserves the exact
 * pre-4.8 fallback behaviour (fall through on anything unrecognized) for
 * every error this function doesn't confidently classify, so adding
 * classification can only ever *narrow* what falls through — never break a
 * chain that worked before.
 *
 * Already-classified errors pass through untouched, so wrapping twice (a
 * provider inside createFallbackProvider, say) is a no-op rather than a
 * double-wrap that buries `cause` one level deeper.
 */
export function classifyProviderError(err: unknown, provider: string): ProviderError {
  if (err instanceof ProviderError) return err;

  const record = (typeof err === "object" && err !== null ? err : {}) as Record<string, unknown>;
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  // `status` is the OpenAI and Anthropic SDKs' field; `code` covers Node's
  // transport errors (ECONNRESET, ETIMEDOUT) which have no status at all.
  const status = typeof record.status === "number" ? record.status : undefined;
  const transportCode = typeof record.code === "string" ? record.code : undefined;
  const opts = { cause: err, status };

  if (CONTEXT_LENGTH_PATTERNS.some((p) => lower.includes(p))) {
    return new ContextLengthExceededError(provider, message, opts);
  }
  if (status === 429 || RATE_LIMIT_PATTERNS.some((p) => lower.includes(p))) {
    return new RateLimitError(provider, message, { ...opts, retryAfterMs: retryAfterMs(record) });
  }
  if (status === 401 || status === 403) {
    return new ProviderAuthError(provider, message, opts);
  }
  if ((status !== undefined && status >= 500) || transportCode !== undefined) {
    return new ProviderUnavailableError(provider, message, opts);
  }
  if (status !== undefined && status >= 400) {
    return new ProviderRequestInvalidError(provider, message, opts);
  }
  return new ProviderError(message, "provider_error", provider, true, opts);
}

/**
 * Runs a provider call, classifying anything it throws.
 *
 * Every built-in provider's chat()/chatStream() routes through this, so the
 * taxonomy is a property of the seam rather than of any one vendor. A custom
 * `LLMProvider` written by a caller doesn't get it automatically — and
 * doesn't need it: `classifyProviderError()`'s unrecognized-error default is
 * `retriable: true`, which is how every error behaved before this existed.
 *
 * `AbortError` is re-thrown unclassified, and that exception is the point of
 * the whole file. A cancellation is the caller getting what they asked for,
 * not a provider failing; classifying it as a retriable provider error would
 * make `createFallbackProvider()` respond to `abort()` by dutifully trying
 * the next provider. See REMEDIATION 4.2.
 */
export async function withProviderErrors<T>(provider: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw classifyProviderError(err, provider);
  }
}

/**
 * Wraps an `LLMProvider` so both of its call paths classify what they throw.
 *
 * Applied at the object level rather than inside each `chat()`/`chatStream()`
 * body, so a provider gains the taxonomy by construction and can't acquire a
 * third call path later that quietly misses it. `chatStream` stays absent
 * when the wrapped provider doesn't implement it — `Agent` treats its absence
 * as "no incremental events", so materializing it as a defined-but-throwing
 * key would turn a supported provider into a broken one.
 *
 * Deliberately not exported from `index.ts`: it's for the built-in providers.
 * A caller writing their own `LLMProvider` can use it, but doesn't need to —
 * unclassified errors keep their pre-4.8 behaviour everywhere.
 */
export function wrapProviderErrors(provider: LLMProvider): LLMProvider {
  return {
    ...provider,
    chat: (params) => withProviderErrors(provider.name, () => provider.chat(params)),
    ...(provider.chatStream
      ? { chatStream: (params, onText) => withProviderErrors(provider.name, () => provider.chatStream!(params, onText)) }
      : {}),
  };
}

/**
 * True for the several shapes a cancellation arrives in: the DOMException
 * `AbortController` itself raises, the `APIUserAbortError` the OpenAI and
 * Anthropic SDKs raise when their own signal fires, and Node's
 * `ABORT_ERR`/`ERR_CANCELED` codes.
 *
 * Matching on `name` rather than `instanceof DOMException` is deliberate:
 * these cross package boundaries and, in the SDK cases, aren't DOMExceptions
 * at all.
 */
export function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const record = err as { name?: unknown; code?: unknown };
  return (
    record.name === "AbortError" ||
    record.name === "APIUserAbortError" ||
    record.code === "ABORT_ERR" ||
    record.code === "ERR_CANCELED"
  );
}
