/**
 * Context-window management — REMEDIATION 4.1.
 *
 * `Agent.loop()` copied the message list and only ever appended to it.
 * Nothing trimmed, nothing summarized, no token budget existed, and a
 * provider's context-length error wasn't detected — it was traced and
 * rethrown like any other failure. `session.ts` said outright that it does no
 * trimming, and `run()` prepends every prior session item then persists every
 * tool-call and tool-result message it produces.
 *
 * The failure mode that produces is worse than a slow degradation: a
 * long-lived session grows until the *next* run() exceeds the window, and
 * then every subsequent run() fails the same way, permanently, with no
 * recovery path short of dropping the session. The history that makes the
 * session valuable is exactly what makes it unusable.
 *
 * Two mechanisms here, and they're complementary rather than alternatives:
 *
 * - **Budgeted compaction**, applied before each call when `maxInputTokens`
 *   is set. Proactive, cheap, and predictable.
 * - **Trim-and-retry**, triggered by a `ContextLengthExceededError` coming
 *   back from a provider. Reactive, and the only thing that helps a caller
 *   who set no budget or whose estimate was wrong — which, given the
 *   estimator below, is everyone eventually.
 */

import type { AgentMessage, Tool } from "./types.js";

/**
 * Rough token count for a string: characters / 4.
 *
 * This is an estimate and is documented as one everywhere it surfaces. A real
 * count needs the model's own tokenizer, which differs per vendor and per
 * model, would add a heavyweight dependency (or a network call) to a hot
 * path, and would still be wrong for any OpenAI-compatible endpoint serving a
 * model this package has never heard of.
 *
 * The ratio is deliberately conservative for English prose (~4 chars/token in
 * practice) and *under*-estimates for JSON, which tokenizes worse — which is
 * why `reserveTokens` below defaults to a real margin rather than zero, and
 * why trim-and-retry exists as the backstop for when this is wrong anyway.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimated tokens for one message, counting its tool-call arguments and tool-result payload — often the largest part of an agentic history, and the part a naive text-only count misses entirely. */
export function estimateMessageTokens(message: AgentMessage): number {
  let total = message.text ? estimateTokens(message.text) : 0;
  for (const call of message.toolCalls ?? []) {
    total += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.input ?? null));
  }
  if (message.toolResult) {
    total += estimateTokens(message.toolResult.name) + estimateTokens(JSON.stringify(message.toolResult.output ?? null));
  }
  // Per-message envelope: role, delimiters, and the vendor's own framing.
  // Small, but it's the difference between a 200-message history being
  // underestimated by nothing and by a few hundred tokens.
  return total + 4;
}

/** What the fixed parts of a request cost — the system prompt and every tool's JSON Schema. Counted because they're sent on every single turn and, with a large tool list, can dominate a short conversation. */
export function estimateFixedTokens(system: string | undefined, tools: Tool[]): number {
  let total = system ? estimateTokens(system) : 0;
  for (const tool of tools) {
    total += estimateTokens(tool.name) + estimateTokens(tool.description) + estimateTokens(JSON.stringify(tool.inputSchema));
  }
  return total;
}

export interface ContextPolicy {
  /**
   * Token ceiling for everything sent in one call — system prompt, tool
   * schemas, and message history together. Unset means no proactive
   * compaction; trim-and-retry still applies.
   *
   * Set it to something below the model's real window, since the count is an
   * estimate. `reserveTokens` handles the rest.
   */
  maxInputTokens?: number;
  /**
   * Headroom held back from `maxInputTokens`, for the model's *output* and
   * for the estimator being wrong. Defaults to 1024, which is a real margin
   * rather than a token gesture: the estimator under-counts JSON, and JSON is
   * most of what an agentic history is made of.
   */
  reserveTokens?: number;
  /**
   * Messages at the end of the history that compaction will never drop,
   * regardless of budget. Defaults to 6 — enough to hold the current task and
   * a tool-call round trip or two, so compaction can't amputate the exchange
   * the model is in the middle of.
   */
  keepRecentMessages?: number;
  /**
   * Called with the messages compaction is about to drop; whatever it returns
   * is inserted in their place as a single user message, prefixed to mark it
   * as a summary rather than something the user said.
   *
   * Absent means dropped messages are simply gone. Present means an extra LLM
   * call per compaction, which is why it isn't the default — a summarizer is
   * a cost decision, and a silent one would be a surprising bill.
   */
  summarize?: (dropped: AgentMessage[]) => Promise<string>;
}

const DEFAULT_RESERVE_TOKENS = 1024;
const DEFAULT_KEEP_RECENT = 6;

/** Marks a summary so it can't be mistaken for something the user typed — and so a reader of a transcript can see where history was compacted. */
export const SUMMARY_PREFIX = "[earlier conversation, summarized]";

/**
 * Indices of messages that must travel together.
 *
 * An assistant turn carrying tool calls and the tool results answering it are
 * one indivisible unit: every vendor rejects an assistant message whose
 * `tool_calls` have no matching results, and equally rejects a tool result
 * with no preceding call. A trim that cuts between them turns a
 * context-length error into a hard 400 on every subsequent turn — strictly
 * worse than the problem it was solving, and the reason this function exists
 * rather than a plain `slice()`.
 *
 * REMEDIATION 3.5 had to solve the same adjacency problem from the other
 * direction (a crash mid-turn leaving unanswered calls); this is the same
 * invariant enforced at a different seam.
 */
function groupBoundaries(messages: AgentMessage[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    // A tool result belongs to the group its assistant turn opened, so it
    // never starts one.
    if (message.role === "tool") continue;
    starts.push(i);
  }
  return starts;
}

export interface CompactionResult {
  messages: AgentMessage[];
  /** True when anything was actually dropped — the caller uses this to decide whether a retry is worth attempting. */
  compacted: boolean;
  droppedCount: number;
}

/**
 * Drops the oldest complete groups until the estimated request fits the
 * budget, optionally replacing them with a summary.
 *
 * Oldest-first because recency is the cheapest useful proxy for relevance,
 * and because the alternative — scoring messages for importance — is a
 * retrieval problem, not a windowing one. A caller who needs that has
 * `retriever` for it.
 */
export async function compactMessages(
  messages: AgentMessage[],
  fixedTokens: number,
  policy: ContextPolicy,
): Promise<CompactionResult> {
  const max = policy.maxInputTokens;
  if (max === undefined) return { messages, compacted: false, droppedCount: 0 };

  const budget = max - (policy.reserveTokens ?? DEFAULT_RESERVE_TOKENS) - fixedTokens;
  const keepRecent = policy.keepRecentMessages ?? DEFAULT_KEEP_RECENT;
  const perMessage = messages.map(estimateMessageTokens);
  const total = perMessage.reduce((a, b) => a + b, 0);
  if (total <= budget) return { messages, compacted: false, droppedCount: 0 };

  // Candidate cut points, newest first, never cutting into the protected
  // tail. A budget so small that even the tail doesn't fit is not made
  // better by sending nothing: the tail goes out and the provider gets to
  // give the caller a real, actionable error.
  const starts = groupBoundaries(messages).filter((i) => i < Math.max(0, messages.length - keepRecent));

  let cut = 0;
  for (const start of starts) {
    const remaining = perMessage.slice(start).reduce((a, b) => a + b, 0);
    cut = start;
    if (remaining <= budget) break;
  }
  if (cut === 0) return { messages, compacted: false, droppedCount: 0 };

  const dropped = messages.slice(0, cut);
  const kept = messages.slice(cut);

  if (!policy.summarize) {
    return { messages: kept, compacted: true, droppedCount: dropped.length };
  }

  const summary = await policy.summarize(dropped);
  return {
    messages: [{ role: "user", text: `${SUMMARY_PREFIX}\n${summary}` }, ...kept],
    compacted: true,
    droppedCount: dropped.length,
  };
}

/**
 * The emergency budget used when a provider reports a context overflow and
 * the caller set no `maxInputTokens` of their own.
 *
 * There is no way to ask a provider what its window is, and the error message
 * doesn't reliably carry it. So this halves the estimated size of what was
 * just rejected: a value guaranteed to be smaller than something the model
 * refused, without pretending to know the real limit. Repeated overflows
 * halve again, so the retry converges rather than guessing once and giving up.
 */
export function emergencyBudget(messages: AgentMessage[], fixedTokens: number): number {
  const used = messages.reduce((total, m) => total + estimateMessageTokens(m), 0) + fixedTokens;
  return Math.floor(used / 2);
}
