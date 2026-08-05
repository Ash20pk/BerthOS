import { z } from "zod";
import type { AgentRunResult } from "./agent.js";
import type { ComputerHandle } from "./computer.js";
import type { LLMProvider } from "./types.js";
import { parseStructuredOutput } from "./structured-output.js";
import { findExportTool } from "./checkpoint.js";

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

export interface EvalRunRecord extends EvalSuiteResult {
  suiteName: string;
  runId: string;
  timestamp: number;
}

const EVAL_RUNS_DIR = "eval-runs";
/** Tagged onto every recorded run's relatedApps so listEvalRuns() can find them all via one query_context call — same pattern tracing.ts's listAgentTraces() already established. */
const EVAL_RUN_INDEX_MARKER = "eval-run-index";

function slugify(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "suite";
}

function pathFor(suiteName: string, runId: string): string {
  return `${EVAL_RUNS_DIR}/${slugify(suiteName)}/${runId}.json`;
}

/**
 * Persists one suite run to Semantic FS so pass-rate-over-time is something
 * you can actually look back at, not just a number printed once to a
 * terminal and lost. Goes through the exact same generic write_context_file/
 * tag_context_file resolution checkpoint.ts's findExportTool already uses —
 * works with any app exposing that contract, not apps/filesystem
 * specifically. `runId` defaults to the current timestamp (unique enough for
 * "one suite run"), but a caller can supply its own for reproducible tests
 * or to correlate with an external run id (a CI job id, say).
 */
export async function recordEvalRun(
  computer: ComputerHandle,
  suiteName: string,
  suite: EvalSuiteResult,
  options: { runId?: string } = {},
): Promise<EvalRunRecord> {
  const writeTool = findExportTool(computer.tools, "write_context_file", "recordEvalRun()");
  const tagTool = findExportTool(computer.tools, "tag_context_file", "recordEvalRun()");

  // Date.now() alone isn't unique enough for two runs recorded in quick
  // succession (well within the same millisecond in a tight test loop, or
  // a fast CI job) — the random suffix is what actually guarantees
  // uniqueness when a caller doesn't supply its own runId.
  const runId = options.runId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record: EvalRunRecord = { suiteName, runId, timestamp: Date.now(), ...suite };
  const path = pathFor(suiteName, runId);

  await writeTool.invoke({ path, content: JSON.stringify(record) });
  await tagTool.invoke({ path, task: suiteName, relatedApps: [EVAL_RUN_INDEX_MARKER] });

  return record;
}

/** Reads back one recorded run — null if nothing was ever recorded under that suiteName/runId. */
export async function readEvalRun(computer: ComputerHandle, suiteName: string, runId: string): Promise<EvalRunRecord | null> {
  const readTool = findExportTool(computer.tools, "read_context_file", "readEvalRun()");
  try {
    const result = (await readTool.invoke({ path: pathFor(suiteName, runId) })) as { content: string };
    return JSON.parse(result.content) as EvalRunRecord;
  } catch {
    return null;
  }
}

/**
 * Lists every recorded run, newest first — no suiteName/runId needed up
 * front, the same "one query_context call over a fixed marker" pattern
 * tracing.ts's listAgentTraces() already uses. Pass `suiteName` to narrow to
 * one suite's history (pass-rate-over-time for that suite specifically).
 */
export async function listEvalRuns(
  computer: ComputerHandle,
  options: { suiteName?: string; limit?: number } = {},
): Promise<{ suiteName: string; runId: string; updatedAt: number }[]> {
  const queryTool = findExportTool(computer.tools, "query_context", "listEvalRuns()");
  const { results } = (await queryTool.invoke({ text: EVAL_RUN_INDEX_MARKER })) as {
    results: { path: string; task?: string; updatedAt: number }[];
  };

  const prefix = options.suiteName ? `${EVAL_RUNS_DIR}/${slugify(options.suiteName)}/` : `${EVAL_RUNS_DIR}/`;
  const runs = results
    .filter((hit) => hit.path.startsWith(prefix) && hit.path.endsWith(".json"))
    .map((hit) => {
      const withoutPrefix = hit.path.slice(EVAL_RUNS_DIR.length + 1);
      const [suiteSlug, file] = withoutPrefix.split("/");
      if (!suiteSlug || !file) return null;
      return { suiteName: hit.task ?? suiteSlug, runId: file.slice(0, -".json".length), updatedAt: hit.updatedAt };
    })
    .filter((run): run is { suiteName: string; runId: string; updatedAt: number } => run !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return options.limit ? runs.slice(0, options.limit) : runs;
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
