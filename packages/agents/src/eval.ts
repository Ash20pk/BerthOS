import { z } from "zod";
import type { AgentRunResult } from "./agent.js";
import type { LLMProvider } from "./types.js";
import { parseStructuredOutput } from "./structured-output.js";

/** Anything an eval case can be run against — an `Agent` satisfies this directly; a `Crew` needs a one-line adapter. */
export interface EvalRunnable {
  run(input: string): Promise<AgentRunResult>;
}

export interface EvalAssertionResult {
  pass: boolean;
  message: string;
}

/** A single check against a completed run's result — see containsText()/matchesPattern()/calledTool()/llmJudge() for the built-in ones. */
export type EvalAssertion = (result: AgentRunResult) => EvalAssertionResult | Promise<EvalAssertionResult>;

export interface EvalCase {
  name: string;
  input: string;
  assertions: EvalAssertion[];
}

export interface EvalCaseResult {
  name: string;
  passed: boolean;
  input: string;
  text: string;
  assertionResults: EvalAssertionResult[];
  /** Set when the run itself threw — a tool error surviving to a crash, maxTurns exceeded, etc. `assertionResults` is empty in that case: there's no result to check assertions against. */
  error?: string;
}

export interface EvalSuiteResult {
  total: number;
  passed: number;
  failed: number;
  results: EvalCaseResult[];
}

/**
 * `berth test` only checks manifest/export shape bijection — it has never
 * invoked an LLM or asserted anything about agent *behavior*. This is the
 * missing regression-suite primitive: run each case's `input` through
 * `runnable`, check every assertion against the result, and report pass/fail
 * per case plus a suite-level summary. One failing case's run throwing
 * doesn't stop the others — each case is independent.
 */
export async function runEvalSuite(runnable: EvalRunnable, cases: EvalCase[]): Promise<EvalSuiteResult> {
  const results: EvalCaseResult[] = [];

  for (const evalCase of cases) {
    try {
      const result = await runnable.run(evalCase.input);
      const assertionResults = await Promise.all(evalCase.assertions.map((assertion) => assertion(result)));
      results.push({
        name: evalCase.name,
        passed: assertionResults.every((r) => r.pass),
        input: evalCase.input,
        text: result.text,
        assertionResults,
      });
    } catch (err) {
      results.push({
        name: evalCase.name,
        passed: false,
        input: evalCase.input,
        text: "",
        assertionResults: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

export function containsText(substring: string): EvalAssertion {
  return (result) => {
    const pass = result.text.includes(substring);
    return { pass, message: pass ? `contains "${substring}"` : `expected text to contain "${substring}", got: ${JSON.stringify(result.text)}` };
  };
}

export function matchesPattern(pattern: RegExp): EvalAssertion {
  return (result) => {
    const pass = pattern.test(result.text);
    return { pass, message: pass ? `matches ${pattern}` : `expected text to match ${pattern}, got: ${JSON.stringify(result.text)}` };
  };
}

/** Asserts a specific tool was called during the run — useful for checking an agent actually used a tool rather than hallucinating an answer. */
export function calledTool(toolName: string): EvalAssertion {
  return (result) => {
    const pass = result.toolCalls.some((call) => call.name === toolName);
    const called = result.toolCalls.map((call) => call.name).join(", ") || "(none)";
    return { pass, message: pass ? `called tool "${toolName}"` : `expected a call to tool "${toolName}", got calls: ${called}` };
  };
}

export interface LlmJudgeOptions {
  /** The model doing the judging — can be the same provider the agent under test uses, or a different (often stronger) one. */
  judge: LLMProvider;
  /** What "passing" means for this case, in plain language — becomes the judge's grading criteria. */
  rubric: string;
}

const judgeVerdictSchema = z.object({ pass: z.boolean(), reason: z.string() });

/**
 * The LLM-as-judge assertion: asks `judge` whether the run's final text
 * satisfies `rubric`, for checks too fuzzy for an exact string/regex match
 * ("is this a polite refusal", "does this correctly summarize the
 * document"). Reuses parseStructuredOutput() (see structured-output.ts) to
 * force the judge's own response into a `{pass, reason}` verdict rather than
 * parsing free text — the same repair-loop machinery Agent.run()'s
 * responseSchema uses, just called directly here since a single judge
 * call doesn't need Agent's tool-use loop around it. A verdict that doesn't
 * parse counts as a failed assertion (with the parse error as the message),
 * not a thrown error — one bad judge response shouldn't crash the whole suite.
 */
export function llmJudge({ judge, rubric }: LlmJudgeOptions): EvalAssertion {
  return async (result) => {
    const prompt =
      `Evaluate the following agent response against this rubric:\n${rubric}\n\n` +
      `Agent response:\n${result.text}\n\n` +
      `Respond with ONLY JSON matching {"pass": boolean, "reason": string} — no prose, no markdown code fences.`;

    const turn = await judge.chat({ messages: [{ role: "user", text: prompt }], tools: [] });
    const verdict = parseStructuredOutput(turn.text ?? "", judgeVerdictSchema);

    if (!verdict.success) {
      return { pass: false, message: `judge response could not be parsed as a verdict: ${verdict.error}` };
    }
    return { pass: verdict.data.pass, message: verdict.data.reason };
  };
}
