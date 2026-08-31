/**
 * Passed to `Tool.invoke()` as an optional second argument — REMEDIATION 4.2.
 *
 * Optional, and second, so that every Tool written before this existed stays
 * valid: an `invoke: async (input) => ...` simply ignores it. A tool that
 * *does* accept it should abandon its work when the signal fires and reject
 * with an `AbortError`, the same contract `fetch` follows.
 */
export interface ToolInvocationContext {
  /**
   * Fires when the run this call belongs to is cancelled — the caller
   * aborted, the run's wall-clock deadline elapsed, or this individual call
   * exceeded its own timeout.
   */
  signal?: AbortSignal;
}

/** The single interface a Computer's resident-app exports, and other Agents, both implement — see Agent.asTool(). */
export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: object;
  invoke(input: unknown, ctx?: ToolInvocationContext): Promise<unknown>;
}

export type AgentRole = "user" | "assistant" | "tool";

export interface AgentMessage {
  role: AgentRole;
  /** Present on "user"/"assistant" turns with text content. */
  text?: string;
  /** Present on "assistant" turns that requested tool calls. */
  toolCalls?: { id: string; name: string; input: unknown }[];
  /** Present on "tool" turns — the result fed back for a prior toolCalls[].id. */
  toolResult?: { id: string; name: string; output: unknown };
}

/**
 * Why a turn ended, normalized across vendors whose own vocabularies don't
 * line up (OpenAI's `finish_reason`, Anthropic's `stop_reason`, Gemini's
 * `finishReason`). The distinction that matters is between an ending the
 * model chose and one imposed on it:
 *
 * - `"end"` / `"tool_calls"` — the model finished, or stopped to call a tool.
 * - `"length"` — cut off at a token cap. The text is a fragment, and any tool
 *   call in it may have truncated arguments.
 * - `"content_filter"` — the provider suppressed the output.
 * - `"refusal"` — the model declined. Distinct from a filter: it's an answer.
 * - `"other"` — a vendor-specific reason with no equivalent here.
 *
 * Absent when a provider doesn't report one. Absent means "unknown", never
 * "fine" — Agent only acts on a reason it was actually given.
 */
export type LLMStopReason = "end" | "tool_calls" | "length" | "content_filter" | "refusal" | "other";

/**
 * Thrown by Agent.run()/resume() when a turn ended for a reason that makes
 * its output untrustworthy as an answer — cut off at a token cap, suppressed
 * by a content filter, or declined by the model. Before this, such a turn
 * came back with `toolCalls: []` and the loop returned the fragment as the
 * final answer; with a `responseSchema` it burned every repair attempt on
 * half-JSON that could never parse. See REMEDIATION 3.2.
 *
 * `partialText` is whatever the model did produce, for a caller that wants to
 * log or salvage it — the same affordance StructuredOutputError's `rawText`
 * already offers.
 */
export class TruncatedResponseError extends Error {
  constructor(
    readonly agentName: string,
    readonly stopReason: LLMStopReason,
    readonly partialText: string,
  ) {
    super(
      stopReason === "length"
        ? `Agent "${agentName}" got a response cut off at the model's token limit, not a finished answer. ` +
          `Raise maxTokens on the provider, or shorten the input.`
        : `Agent "${agentName}" got no usable answer: the provider reported "${stopReason}".`,
    );
    this.name = "TruncatedResponseError";
  }
}

export interface LLMTurn {
  text?: string;
  toolCalls: { id: string; name: string; input: unknown }[];
  /** True once the model has nothing further to do — no pending tool calls. */
  stop: boolean;
  /**
   * Why this turn ended, when the provider says. Read by Agent.run() to tell
   * a real final answer apart from a truncated or suppressed one — before
   * this existed, a response cut off at the token cap came back with
   * `toolCalls: []` and was returned to the caller as the final answer.
   * See REMEDIATION 3.2.
   */
  stopReason?: LLMStopReason;
  /** Token accounting for this one call, when the provider's API reports it. Absent, not zero, when a provider doesn't. */
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * The "bring your own LLM" seam. Any provider implementing this can drive an
 * Agent. @berth/agents ships six vendor providers — createAnthropicProvider,
 * createOpenAIProvider, createGoogleProvider, createAzureOpenAIProvider,
 * createBedrockProvider, createOllamaProvider — plus
 * createOpenAICompatibleProvider() for any OpenAI-shaped endpoint, and
 * createFallbackProvider() for retry-through-a-chain. Nothing in
 * Computer/Agent/Crew references a specific vendor.
 */
/**
 * What every LLMProvider call receives. `signal` is REMEDIATION 4.2: without
 * it a cancelled run still held an in-flight completion open to its natural
 * end, so `abort()` stopped the *loop* while the tokens kept being paid for.
 * Every built-in provider forwards it to its vendor SDK, all of which accept
 * one. A custom provider that ignores it still works — the loop stops either
 * way, it just can't stop the request already in flight.
 */
export interface LLMCallParams {
  system?: string;
  messages: AgentMessage[];
  tools: Tool[];
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly name: string;
  chat(params: LLMCallParams): Promise<LLMTurn>;
  /**
   * Same request/response contract as chat(), but calls onText(delta) for
   * each chunk of assistant text as the model produces it, instead of only
   * returning the full text once the turn is complete. Optional: a provider
   * that doesn't implement this can still drive an Agent exactly as before —
   * Agent.run()/resume() fall back to chat() when it's absent, simply
   * without incremental text events.
   */
  chatStream?(params: LLMCallParams, onText: (delta: string) => void): Promise<LLMTurn>;
}
