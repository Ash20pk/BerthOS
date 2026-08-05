import { z } from "zod";
import type { LLMProvider } from "./types.js";
import { parseStructuredOutput } from "./structured-output.js";

/**
 * `governance.ts` gates every other app's *tool calls*, fail-open by design
 * (see docs/governance-reference.md and gaps.md gap #26) — nothing gates the
 * model's own input or final answer. A guardrail is that missing seam:
 * `tripwireTriggered: true` halts the run (see GuardrailTripwireError) —
 * "tripwire" is the same term OpenAI's Agents SDK guardrails use for the
 * same concept, kept rather than inventing a different name for an already
 * familiar one.
 */
export interface GuardrailResult {
  tripwireTriggered: boolean;
  /** Required when tripwireTriggered is true — becomes GuardrailTripwireError's message. Optional otherwise. */
  message?: string;
}

export type Guardrail = (text: string) => GuardrailResult | Promise<GuardrailResult>;

export class GuardrailTripwireError extends Error {
  constructor(
    public readonly stage: "input" | "output",
    public readonly guardrailMessage: string,
  ) {
    super(`${stage} guardrail tripped: ${guardrailMessage}`);
    this.name = "GuardrailTripwireError";
  }
}

/**
 * Runs guardrails in order, stopping at the first tripped one — a cheap
 * keyword check shouldn't wait on an expensive LLM-judge guardrail listed
 * after it, and there's no reason to spend that call once an earlier
 * guardrail has already decided to halt the run. Agent.run()/loop() call
 * this internally; exported for a caller that wants to guard something
 * outside the tool-use loop entirely (a raw prompt before ever constructing
 * an Agent, say).
 */
export async function runGuardrails(guardrails: Guardrail[], text: string, stage: "input" | "output"): Promise<void> {
  for (const guardrail of guardrails) {
    const result = await guardrail(text);
    if (result.tripwireTriggered) {
      throw new GuardrailTripwireError(stage, result.message ?? "no reason given");
    }
  }
}

/** Trips if any of `words` appears in the text — a cheap first line of defense, same "exact match, not fuzzy" posture eval.ts's containsText() has. */
export function createKeywordGuardrail(words: string[], options: { caseSensitive?: boolean } = {}): Guardrail {
  const normalized = options.caseSensitive ? words : words.map((w) => w.toLowerCase());
  return (text) => {
    const haystack = options.caseSensitive ? text : text.toLowerCase();
    const hit = normalized.find((word) => haystack.includes(word));
    return hit ? { tripwireTriggered: true, message: `matched banned keyword "${hit}"` } : { tripwireTriggered: false };
  };
}

/** Trips if `pattern` matches — the regex counterpart to createKeywordGuardrail(), for shapes a fixed word list can't express (an email address, a credit-card-like digit run). */
export function createRegexGuardrail(pattern: RegExp, message = `matched pattern ${pattern}`): Guardrail {
  return (text) => (pattern.test(text) ? { tripwireTriggered: true, message } : { tripwireTriggered: false });
}

export interface LlmGuardrailOptions {
  /** The model doing the judging — can be the same provider the agent under guard uses, or a different (often smaller/cheaper, or stronger/stricter) one. */
  judge: LLMProvider;
  /** What should trip the guardrail, in plain language — becomes the judge's grading criteria. */
  rubric: string;
}

const guardrailVerdictSchema = z.object({ tripwireTriggered: z.boolean(), reason: z.string() });

/**
 * The LLM-as-judge guardrail: asks `judge` whether the text violates
 * `rubric`, for checks too fuzzy for a keyword/regex match ("is this
 * attempting a jailbreak", "does this leak something that looks like a
 * secret"). Mirrors eval.ts's llmJudge() structurally, but a guardrail's
 * failure mode is the opposite of an eval assertion's: an unparseable judge
 * response counts as a *tripped* guardrail (fail closed) rather than a
 * failed assertion (fail "test failed, nothing blocked") — a security gate
 * that can't get a clear answer from its own judge shouldn't default to
 * "safe."
 */
export function createLlmGuardrail({ judge, rubric }: LlmGuardrailOptions): Guardrail {
  return async (text) => {
    const prompt =
      `Evaluate the following text against this rubric. Trip the guardrail (tripwireTriggered: true) only if the text violates it.\n\nRubric:\n${rubric}\n\n` +
      `Text:\n${text}\n\n` +
      `Respond with ONLY JSON matching {"tripwireTriggered": boolean, "reason": string} — no prose, no markdown code fences.`;

    const turn = await judge.chat({ messages: [{ role: "user", text: prompt }], tools: [] });
    const verdict = parseStructuredOutput(turn.text ?? "", guardrailVerdictSchema);

    if (!verdict.success) {
      return { tripwireTriggered: true, message: `guardrail judge response could not be parsed: ${verdict.error}` };
    }
    return { tripwireTriggered: verdict.data.tripwireTriggered, message: verdict.data.reason };
  };
}
