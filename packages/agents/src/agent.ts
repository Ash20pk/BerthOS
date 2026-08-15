import type { z } from "zod";
import { Computer, type BootComputerOptions, type ConnectComputerOptions } from "./computer.js";
import { resolveLLMProvider, type LLMProviderConfig } from "./providers/auto.js";
import { createSemanticFsCheckpointStore, type CheckpointedRun, type CheckpointStore } from "./checkpoint.js";
import { createAgentTracer, type StepTracer } from "./tracing.js";
import { createOtelStepTracer } from "./otel-tracer.js";
import { applyHumanApprovalGate, HumanApprovalDeniedError, type HumanApprovalGateOptions } from "./approval.js";
import {
  parseStructuredOutput,
  structuredOutputRepairPrompt,
  StructuredOutputError,
  formatToolInputError,
} from "./structured-output.js";
import { createSemanticFsRetriever, type Retriever } from "./retrieval.js";
import { createMcpClientTools, type McpClientHandle, type McpClientToolsOptions } from "./mcp-client.js";
import { runGuardrails, GuardrailTripwireError, type Guardrail } from "./guardrails.js";
import type { GovernanceGate } from "./governance.js";
import type { Session } from "./session.js";
import {
  CheckpointNotFoundError,
  CheckpointStoreMissingError,
  ContextLengthExceededError,
  MaxTurnsExceededError,
  UnknownToolError,
  isAbortError,
} from "./errors.js";
import { createRunCancellation, withToolTimeout, type RunCancellation } from "./cancellation.js";
import { compactMessages, emergencyBudget, estimateFixedTokens, type ContextPolicy } from "./context.js";
import { TruncatedResponseError, type AgentMessage, type LLMProvider, type Tool } from "./types.js";

export interface AgentOptions {
  name?: string;
  systemPrompt?: string;
  llm: LLMProvider;
  tools: Tool[];
  /** Safety cap on the tool-use loop, in case a provider never stops requesting tool calls. */
  maxTurns?: number;
  /**
   * When set, run()/resume() persist progress after every turn — the fix for
   * "a crash mid-loop loses everything": a fresh process can call
   * agent.resume(runId) and pick the tool-use loop back up from the last
   * saved turn instead of re-running from scratch. See checkpoint.ts.
   */
  checkpoint?: CheckpointStore;
  /**
   * The governance authority to route this agent's own *delegation* through
   * — see asTool(). Set by createAgent() from the Computer it built; there
   * is no reason to pass it by hand. Every other tool an agent holds is
   * already gated at that Computer's dispatch (REMEDIATION.md 1.13).
   */
  governance?: GovernanceGate;
  /**
   * When set alongside `runId`, run()/resume() emit an AgentStepEvent after
   * every LLM turn and every tool call — turn number, duration, and error if
   * any. See tracing.ts. No `runId` means no events, same "constructor-level
   * seam, run-level activation" shape as `checkpoint`.
   */
  trace?: StepTracer;
  /**
   * Run against the raw input string before the first LLM call, in order,
   * stopping at the first tripped one — a tripped guardrail throws
   * GuardrailTripwireError, and the loop never starts. Applies only to
   * run(), not resume() (a resumed run's original input already passed this
   * check, or the run wouldn't have gotten far enough to checkpoint). See
   * guardrails.ts.
   */
  inputGuardrails?: Guardrail[];
  /**
   * Run against a final answer's text before run()/resume() returns it, in
   * order, stopping at the first tripped one — a tripped guardrail throws
   * GuardrailTripwireError and checkpoints the run as "error" (when
   * checkpointing is configured) rather than returning the flagged text.
   * Runs on every final-answer path, including a resumed run's. See
   * guardrails.ts.
   */
  outputGuardrails?: Guardrail[];
  /**
   * Wall-clock ceiling for a whole run(), in milliseconds — checked at every
   * loop boundary and propagated to the in-flight LLM call and tool call as
   * an AbortSignal. Unset means no deadline, which was the only behaviour
   * before REMEDIATION 4.2: `maxTurns` bounded how many times the loop went
   * round, and nothing at all bounded how long that took.
   *
   * Overridable per call via run()'s own `timeoutMs`.
   */
  timeoutMs?: number;
  /**
   * Ceiling for a single tool call, in milliseconds. A call that exceeds it
   * comes back to the model as a ToolTimeoutError tool result — a failure it
   * can route around — rather than ending the run. See errors.ts for why
   * that direction, and cancellation.ts for what the bound does and doesn't
   * promise about a tool that ignores its signal.
   */
  toolTimeoutMs?: number;
  /**
   * Bounds how much history is sent to the model, and what happens when it
   * doesn't fit — see context.ts. Unset leaves proactive compaction off, but
   * *not* the reactive half: a provider reporting a context overflow still
   * triggers a trim-and-retry, because the alternative is a session that
   * fails permanently from that point on. See REMEDIATION 4.1.
   */
  context?: ContextPolicy;
}

export interface AgentRunResult {
  text: string;
  toolCalls: { name: string; input: unknown; result: unknown }[];
}

/** Extra options accepted by run()/resume() for the response-schema repair loop. See structured-output.ts. */
export interface StructuredOutputRunOptions<T> {
  /**
   * When set, a final turn (no tool calls) has its text parsed as JSON and
   * validated against this schema before run()/resume() returns. On failure,
   * the model gets the parse/validation error back as a fresh user turn and
   * another chance to respond — up to `maxRepairAttempts` (default 2) — the
   * same "feed the failure back to the model" shape gap #2's tool-error
   * handling already uses, applied to the agent's own final answer instead
   * of a tool call. Exceeding the repair budget throws StructuredOutputError
   * rather than returning invalid data silently.
   */
  responseSchema?: z.ZodType<T>;
  maxRepairAttempts?: number;
}

/**
 * Errors that end the run rather than becoming a tool result the model can
 * work around. Deliberately narrow, and deliberately excluding
 * GovernanceDeniedError: a governance gate is a policy engine shaping which
 * actions an agent may take, and an agent denied one action trying a
 * different one is the intended behaviour. A *human* denying a specific
 * request, or a guardrail tripping, is a stop — not a hint. See
 * REMEDIATION 3.4, and governance.ts for why that gate is advisory by design.
 */
function isRefusal(err: unknown): boolean {
  return err instanceof HumanApprovalDeniedError || err instanceof GuardrailTripwireError;
}

/**
 * Tool calls from the most recent assistant turn that have no matching tool
 * result yet — what a crash partway through a multi-call turn leaves behind.
 * Empty for any complete message history, so this costs a fresh run nothing.
 */
function pendingToolCalls(messages: AgentMessage[]): { id: string; name: string; input: unknown }[] {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.toolCalls?.length);
  if (!lastAssistant?.toolCalls) return [];
  const answered = new Set(
    messages.filter((m) => m.role === "tool" && m.toolResult).map((m) => m.toolResult!.id),
  );
  return lastAssistant.toolCalls.filter((call) => !answered.has(call.id));
}

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

/** The arguments Agent's internal loop takes. Named rather than inlined because both loop() and loopWith() carry it — see loop() for why they're split. */
interface LoopArgs<T> {
  initialMessages: AgentMessage[];
  initialExecuted: AgentRunResult["toolCalls"];
  startTurn: number;
  runId: string | undefined;
  onText: ((delta: string) => void) | undefined;
  responseSchema?: z.ZodType<T>;
  maxRepairAttempts?: number;
  session?: Session;
  sessionBaseline?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * The provider-agnostic tool-use loop: identical regardless of which
 * LLMProvider or which Tool implementations (resident-app exports, other
 * agents via asTool()) are plugged in.
 */
export class Agent {
  readonly name: string;
  readonly tools: Tool[];
  private readonly llm: LLMProvider;
  private readonly systemPrompt: string | undefined;
  private readonly maxTurns: number;
  private readonly checkpointStore: CheckpointStore | undefined;
  private readonly tracer: StepTracer | undefined;
  private readonly inputGuardrails: Guardrail[];
  private readonly outputGuardrails: Guardrail[];
  private readonly timeoutMs: number | undefined;
  private readonly toolTimeoutMs: number | undefined;
  private readonly context: ContextPolicy;
  /**
   * The governance authority of the Computer this agent was built from, set
   * by createAgent(). Only asTool() uses it — every other tool this agent
   * holds was already gated at the Computer's dispatch. Undefined for an
   * Agent constructed directly, which has no Computer and so no governor.
   */
  private readonly governance: GovernanceGate | undefined;

  constructor(options: AgentOptions) {
    this.name = options.name ?? "agent";
    this.systemPrompt = options.systemPrompt;
    this.llm = options.llm;
    this.tools = options.tools;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.checkpointStore = options.checkpoint;
    this.tracer = options.trace;
    this.inputGuardrails = options.inputGuardrails ?? [];
    this.outputGuardrails = options.outputGuardrails ?? [];
    this.governance = options.governance;
    this.timeoutMs = options.timeoutMs;
    this.toolTimeoutMs = options.toolTimeoutMs;
    this.context = options.context ?? {};
  }

  async run<T = never>(
    input: string,
    opts: {
      runId?: string;
      onText?: (delta: string) => void;
      session?: Session;
      /** Cancels this run: the in-flight LLM call and tool call are aborted, and run() rejects with an AbortError. See REMEDIATION 4.2. */
      signal?: AbortSignal;
      /** Overrides the Agent's own `timeoutMs` for this call. */
      timeoutMs?: number;
    } & StructuredOutputRunOptions<T> = {},
  ): Promise<AgentRunResult & { data?: T }> {
    if (this.inputGuardrails.length > 0) {
      await runGuardrails(this.inputGuardrails, input, "input");
    }
    const priorItems = opts.session ? await opts.session.getItems() : [];
    return this.loop({
      initialMessages: [...priorItems, { role: "user", text: input }],
      initialExecuted: [],
      startTurn: 0,
      runId: opts.runId,
      onText: opts.onText,
      responseSchema: opts.responseSchema,
      maxRepairAttempts: opts.maxRepairAttempts,
      session: opts.session,
      sessionBaseline: priorItems.length,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
    });
  }

  /**
   * Continues a run a prior run()/resume() call persisted (via `checkpoint`)
   * but never finished — a crashed process, a killed container, anything
   * that lost the original call stack. Reads the last saved messages/tool
   * log for `runId` and picks the tool-use loop back up from there, rather
   * than re-sending the original task and starting over. Needs `checkpoint`
   * to have been passed to this Agent's constructor: that's what makes the
   * prior progress reachable from a process that doesn't share any memory
   * with the one that made it.
   */
  async resume<T = never>(
    runId: string,
    opts: { onText?: (delta: string) => void; signal?: AbortSignal; timeoutMs?: number } & StructuredOutputRunOptions<T> = {},
  ): Promise<AgentRunResult & { data?: T }> {
    if (!this.checkpointStore) {
      throw new CheckpointStoreMissingError(this.name);
    }
    const checkpoint = await this.checkpointStore.load(runId);
    if (!checkpoint) {
      throw new CheckpointNotFoundError(runId);
    }
    if (checkpoint.status === "done") {
      return { text: checkpoint.text ?? "", toolCalls: checkpoint.toolCalls };
    }
    return this.loop({
      initialMessages: checkpoint.messages,
      initialExecuted: checkpoint.toolCalls,
      startTurn: checkpoint.turnCount,
      runId,
      onText: opts.onText,
      responseSchema: opts.responseSchema,
      maxRepairAttempts: opts.maxRepairAttempts,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
    });
  }

  private async loop<T = never>(args: LoopArgs<T>): Promise<AgentRunResult & { data?: T }> {
    // The deadline is a real timer, so it has to be cleared however the run
    // ends — including the paths that throw. Without this, a run that beats
    // its own timeout by an hour keeps the process alive for that hour.
    const cancellation = createRunCancellation(this.name, args.signal, args.timeoutMs);
    try {
      return await this.loopWith(args, cancellation);
    } finally {
      cancellation.dispose();
    }
  }

  private async loopWith<T = never>(
    args: LoopArgs<T>,
    cancellation: RunCancellation,
  ): Promise<AgentRunResult & { data?: T }> {
    const {
      initialMessages,
      initialExecuted,
      startTurn,
      runId,
      onText,
      responseSchema,
      maxRepairAttempts = DEFAULT_MAX_REPAIR_ATTEMPTS,
      session,
      sessionBaseline = 0,
    } = args;
    const messages = [...initialMessages];
    const executed = [...initialExecuted];
    let repairAttempts = 0;
    // Bounds the trim-and-retry to one attempt per run, so a provider that
    // reports an overflow for some other reason can't drive an endless
    // shrink loop.
    let contextRetried = false;

    const checkpoint = async (turnCount: number, status: CheckpointedRun["status"], text?: string) => {
      if (!this.checkpointStore || !runId) return;
      await this.checkpointStore.save({ runId, agentName: this.name, status, turnCount, messages, toolCalls: executed, text });
    };

    const trace = async (event: Omit<Parameters<StepTracer["emit"]>[0], "runId" | "agentName">) => {
      if (!this.tracer || !runId) return;
      await this.tracer.emit({ ...event, runId, agentName: this.name });
    };

    const runToolCall = async (
      call: { id: string; name: string; input: unknown },
      turnCount: number,
      turnText: string | undefined,
    ) => {
      const tool = this.tools.find((t) => t.name === call.name);
      const callStart = Date.now();
      let result: unknown;
      let error: string | undefined;
      if (!tool) {
        // Fed back to the model rather than thrown, unchanged from before —
        // picking a tool that doesn't exist is a mistake the model can
        // correct on the next turn, and killing the run over it would be a
        // regression. UnknownToolError is used for its *message*, which now
        // names the tools that do exist; "no such tool X" on its own is the
        // least actionable thing to hand a model that just guessed. See
        // REMEDIATION 4.8 and errors.ts.
        error = new UnknownToolError(
          call.name,
          this.tools.map((t) => t.name),
        ).message;
        result = { error };
      } else {
        try {
          result = await withToolTimeout(call.name, this.toolTimeoutMs, cancellation.signal, (signal) =>
            tool.invoke(call.input, { signal }),
          );
        } catch (err) {
          // A refusal is not a failure the model gets to route around.
          // Feeding a human's "no" back as a tool result let the model
          // re-issue the identical call and open a fresh grant request,
          // which turns a denial into "ask again" and spams the human
          // deciding it — documented as fail-closed, behaving as advisory.
          // Same for a guardrail that tripped inside a nested
          // agent-as-tool. See REMEDIATION 3.4.
          if (isRefusal(err)) {
            await checkpoint(turnCount, "error", turnText);
            throw err;
          }
          // A cancelled *run* ends the run — feeding "aborted" back as a tool
          // result would have the model politely retry the call that someone
          // just cancelled. A cancelled *tool* is different and deliberately
          // falls through to the {error} path below: the run is still alive,
          // and one slow tool is a failure the model can route around.
          //
          // Keyed on the run's own signal rather than on the error's shape,
          // because the two are not reliably distinguishable from the error
          // alone: a tool that honours its signal rejects with an AbortError
          // either way, and a run deadline rejects with RunTimeoutError,
          // which is deliberately *not* an AbortError. See cancellation.ts.
          if (cancellation.signal?.aborted) {
            await checkpoint(turnCount, "error", turnText);
            cancellation.throwIfCancelled();
            throw err;
          }
          // Every other failing tool call still feeds an {error} result back
          // to the model, same as the "no such tool" case above, instead of
          // throwing out of the whole loop — the model gets a chance to retry
          // with different input, try another tool, or surface the failure
          // itself, rather than one bad call silently killing the run.
          // formatToolInputError() reformats a Zod input-validation failure's
          // default JSON-array message into the same compact per-field shape
          // responseSchema repair prompts already use — any other error
          // message passes through unchanged.
          error = formatToolInputError(err instanceof Error ? err.message : String(err));
          result = { error };
        }
      }
      await trace({ turn: turnCount, kind: "tool-call", toolName: call.name, durationMs: Date.now() - callStart, error });
      executed.push({ name: call.name, input: call.input, result });
      messages.push({ role: "tool", toolResult: { id: call.id, name: call.name, output: result } });
    };

    // Only fires on a successful, un-guarded final answer — a run a tripped
    // output guardrail killed shouldn't add its (flagged) turn to a
    // session's history either, same reasoning checkpoint()'s "error" status
    // already gets for that case.
    const persistSession = async () => {
      if (!session) return;
      await session.addItems(messages.slice(sessionBaseline));
    };

    const guardOutput = async (text: string, turnCount: number) => {
      if (this.outputGuardrails.length === 0) return;
      try {
        await runGuardrails(this.outputGuardrails, text, "output");
      } catch (err) {
        await checkpoint(turnCount, "error", text);
        throw err;
      }
    };

    // A checkpoint taken mid-turn (see runToolCall) can carry an assistant
    // turn whose later tool calls have no results yet. Sending that to a
    // provider is a hard error — every vendor rejects an assistant message
    // with an unanswered tool_call — so the outstanding calls are finished
    // first, and only then does the loop resume asking the model. Their
    // already-executed siblings are not re-run, which is the entire point of
    // checkpointing per call. See REMEDIATION 3.5.
    const pending = pendingToolCalls(messages);
    for (const call of pending) {
      await runToolCall(call, startTurn, undefined);
    }
    // Unlike the main loop, nothing follows this to record the completed
    // calls, so it checkpoints once here — otherwise a second crash would
    // re-execute everything this resume just finished.
    if (pending.length > 0) await checkpoint(startTurn, "running");

    for (let turnCount = startTurn; turnCount < this.maxTurns; turnCount++) {
      // Checked at the top of every turn, so a run cancelled while a tool was
      // executing stops here rather than spending one more LLM call first.
      cancellation.throwIfCancelled();
      const turnStart = Date.now();
      let turn;

      // Proactive half of REMEDIATION 4.1: compact before the call when a
      // budget is set. Mutates `messages` in place rather than shadowing it,
      // so what gets checkpointed and what gets sent are the same history —
      // otherwise a resumed run would restore the full, over-budget list and
      // fail exactly where the live run had recovered.
      const fixedTokens = estimateFixedTokens(this.systemPrompt, this.tools);
      const compaction = await compactMessages(messages, fixedTokens, this.context);
      if (compaction.compacted) {
        messages.splice(0, messages.length, ...compaction.messages);
        await trace({
          turn: turnCount,
          kind: "context-compaction",
          durationMs: 0,
          droppedMessages: compaction.droppedCount,
        });
      }

      const callParams = { system: this.systemPrompt, messages, tools: this.tools, signal: cancellation.signal };
      try {
        turn =
          onText && this.llm.chatStream
            ? await this.llm.chatStream(callParams, onText)
            : await this.llm.chat(callParams);
      } catch (err) {
        // Reactive half: the provider says the request didn't fit. Without
        // this, a session that outgrew the window failed here and on every
        // subsequent run() forever — the history that makes a session useful
        // being exactly what made it unusable.
        //
        // Retried once per turn, against a budget derived from what was just
        // rejected (see emergencyBudget) rather than a guess at the model's
        // real window, which no API exposes. If compaction can't drop
        // anything more, the error propagates rather than looping.
        if (err instanceof ContextLengthExceededError && !contextRetried) {
          const emergency = await compactMessages(
            messages,
            fixedTokens,
            { ...this.context, maxInputTokens: emergencyBudget(messages, fixedTokens) },
          );
          if (emergency.compacted) {
            messages.splice(0, messages.length, ...emergency.messages);
            contextRetried = true;
            await trace({
              turn: turnCount,
              kind: "context-compaction",
              durationMs: Date.now() - turnStart,
              droppedMessages: emergency.droppedCount,
              error: "recovered from a provider context-length error",
            });
            turnCount--; // Re-run this turn against the compacted history.
            continue;
          }
        }
        await trace({
          turn: turnCount,
          kind: "llm-turn",
          durationMs: Date.now() - turnStart,
          error: err instanceof Error ? err.message : String(err),
        });
        // Turns the provider SDK's own abort (a DOMException, or the vendor's
        // APIUserAbortError) into this package's RunTimeoutError /
        // RunAbortedError, so a caller learns *why* it stopped rather than
        // getting a bare "The operation was aborted" from a dependency.
        if (isAbortError(err)) cancellation.throwIfCancelled();
        throw err;
      }
      await trace({ turn: turnCount, kind: "llm-turn", durationMs: Date.now() - turnStart, usage: turn.usage });

      // Checked before anything in the turn is used, including its tool
      // calls: a response cut off at the token cap can end mid-arguments, so
      // a tool call recovered from one may carry truncated JSON. Only acts
      // on a reason a provider actually reported — an absent stopReason means
      // "unknown", and treating that as suspect would break every
      // OpenAI-compatible server that omits the field. See REMEDIATION 3.2.
      if (turn.stopReason === "length" || turn.stopReason === "content_filter" || turn.stopReason === "refusal") {
        await checkpoint(turnCount, "error", turn.text);
        throw new TruncatedResponseError(this.name, turn.stopReason, turn.text ?? "");
      }

      if (turn.toolCalls.length === 0) {
        const text = turn.text ?? "";

        if (responseSchema) {
          const parsed = parseStructuredOutput(text, responseSchema);
          if (parsed.success) {
            await guardOutput(text, turnCount);
            messages.push({ role: "assistant", text });
            await persistSession();
            await checkpoint(turnCount, "done", text);
            return { text, toolCalls: executed, data: parsed.data };
          }

          if (repairAttempts >= maxRepairAttempts) {
            await checkpoint(turnCount, "error", text);
            throw new StructuredOutputError(
              `Agent "${this.name}" failed to produce output matching responseSchema after ${maxRepairAttempts} repair attempt(s): ${parsed.error}`,
              text,
            );
          }

          repairAttempts++;
          messages.push({ role: "assistant", text });
          messages.push({ role: "user", text: structuredOutputRepairPrompt(parsed.error) });
          await checkpoint(turnCount + 1, "running");
          continue;
        }

        await guardOutput(text, turnCount);
        messages.push({ role: "assistant", text });
        await persistSession();
        await checkpoint(turnCount, "done", text);
        return { text, toolCalls: executed };
      }

      messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });

      for (const [index, call] of turn.toolCalls.entries()) {
        await runToolCall(call, turnCount, turn.text);
        // Checkpoint after *each* call rather than once after the whole turn:
        // a crash between call 3 and call 4 of 4 used to lose all four and
        // re-execute every one on resume, side effects included. turnCount
        // rather than turnCount + 1, because this turn hasn't finished — a
        // resume re-enters at it and finishes only what's outstanding.
        // Skipped for the last call, whose state the turn-end checkpoint
        // below records anyway one line later. See REMEDIATION 3.5.
        if (index < turn.toolCalls.length - 1) await checkpoint(turnCount, "running");
      }

      await checkpoint(turnCount + 1, "running");
    }

    await checkpoint(this.maxTurns, "error");
    // Carries the executed tool calls and the last thing the model said. The
    // bare Error this replaces discarded both, so a caller who wanted to
    // salvage a run that ran long — or just see how far it got — had nothing
    // to work with but a message string. See REMEDIATION 4.8.
    throw new MaxTurnsExceededError(
      this.name,
      this.maxTurns,
      executed,
      [...messages].reverse().find((m) => m.role === "assistant" && m.text)?.text,
    );
  }


  /**
   * Returns a new Agent with the same identity/llm/systemPrompt/checkpoint
   * but an extended tool list — used by Crew.withManager() to give a manager
   * agent one Tool per worker (via worker.asTool()) without mutating either
   * agent.
   */
  withTools(extraTools: Tool[]): Agent {
    return new Agent({
      name: this.name,
      systemPrompt: this.systemPrompt,
      llm: this.llm,
      tools: [...this.tools, ...extraTools],
      maxTurns: this.maxTurns,
      checkpoint: this.checkpointStore,
      trace: this.tracer,
      inputGuardrails: this.inputGuardrails,
      outputGuardrails: this.outputGuardrails,
      governance: this.governance,
    });
  }

  /**
   * Wraps this agent as a Tool — {task: string} in, this.run(task).text out.
   * This is the "agent-as-tool" delegation pattern Crew.withManager() uses:
   * a manager agent's tool list can mix resident-app tools and other agents
   * through the exact same Tool.invoke() dispatch path.
   */
  asTool(description: string): Tool {
    const tool: Tool = {
      name: this.name,
      description,
      inputSchema: {
        type: "object",
        properties: { task: { type: "string", description: "the task to delegate to this agent" } },
        required: ["task"],
      },
      invoke: async (input: unknown, ctx) => {
        const { task } = input as { task: string };
        // The delegate's run inherits the caller's signal, so cancelling a
        // manager cancels the workers it is waiting on rather than leaving
        // them running against a run nobody is listening to any more.
        const result = await this.run(task, { signal: ctx?.signal });
        return result.text;
      },
    };
    // REMEDIATION.md 1.13: delegation used to be completely ungated. A
    // manager agent handed a worker's asTool() could reach every capability
    // that worker holds without the governor being consulted once — the
    // worker's *own* tool calls were gated, but the decision to delegate,
    // and the task text driving it, were not.
    //
    // Gated under `agent:<name>` with a single export, "invoke": a governor
    // is deciding whether this agent may be handed work at all, which is one
    // decision, not one per tool the delegate happens to own.
    //
    // The gate comes from the delegate's own Computer (set by createAgent),
    // which is also the manager's in every shape Crew builds — withManager()
    // composes agents from one Computer. An Agent constructed directly with
    // no Computer has no governor to consult and is returned unchanged.
    return this.governance ? this.governance.gateExternalTool(tool, { app: `agent:${this.name}`, export: "invoke" }) : tool;
  }
}

export interface CreateAgentOptions extends Pick<BootComputerOptions, "network" | "env" | "docker" | "governance"> {
  /** A resident-app directory, or several — a bare string is shorthand for a one-app Computer. First-party (`apps/filesystem`) and custom (`./my-app`) directories mix freely; nothing distinguishes them. Ignored if `computer` or `connect` is given. */
  apps?: string | string[];
  /**
   * Attach to an already-running `berth os up <name>` instance instead of
   * building an image and booting a fresh Computer — the fix for cold start
   * during dev iteration (build+boot only happens once, in `berth os up`).
   * A bare string connects to every app that OS has loaded; `{name, apps}`
   * restricts this Agent to a named subset of them — e.g. an OS shared by
   * several agents, each scoped down to just the apps it actually needs.
   * Mutually exclusive with `apps`/`computer`. See docs/berth-os-reference.md.
   */
  connect?: string | ConnectComputerOptions;
  /**
   * Pass an already-built Computer (from Computer.boot()/Computer.connect())
   * instead of `apps`/`connect` — lets one Computer back several Agents
   * (e.g. a manager and its workers, each with a different tool subset via
   * `computer.tools`/`withTools()`) without booting or connecting more than
   * once. Mutually exclusive with `apps`/`connect`. You own this Computer's
   * lifecycle either way — createAgent() never calls stop() on it, whether
   * it built the Computer itself or received one here.
   */
  computer?: Computer;
  /**
   * Defaults to whichever provider has a real API key in the environment
   * (ANTHROPIC_API_KEY, then OPENAI_API_KEY). Pass a real LLMProvider
   * (`createAnthropicProvider()`/`createOpenAIProvider()`/your own), or a
   * plain config object — `{ provider: "openai", apiKey, baseURL }` — to
   * point at a custom OpenAI/Anthropic-compatible endpoint without an extra
   * import.
   */
  llm?: LLMProvider | LLMProviderConfig;
  systemPrompt?: string;
  name?: string;
  maxTurns?: number;
  /**
   * "semantic-fs" builds a CheckpointStore backed by this Computer's own
   * write_context_file/read_context_file/tag_context_file tools (see
   * createSemanticFsCheckpointStore) — needs an app like apps/filesystem
   * exposing those three exports somewhere in this Computer's app list, or
   * construction throws immediately. Pass a CheckpointStore directly for a
   * different backend (a plain file, a real database).
   */
  checkpoint?: "semantic-fs" | CheckpointStore;
  /**
   * "full" builds a StepTracer that both publishes each step to the Context
   * Bus (topic "agent.step", live tailing) and durably records it to
   * Semantic FS (agent-traces/<runId>.json, replay after the fact) — see
   * createAgentTracer(). Needs an app like apps/filesystem exposing
   * publish_context_event alongside the checkpoint exports, or construction
   * throws immediately. "otel" builds createOtelStepTracer() instead — real
   * OTel spans through whatever SDK/exporter you've already registered
   * globally (Langfuse, Phoenix, Datadog, ...), no Computer/resident-app
   * dependency at all. Pass a StepTracer directly for just one channel
   * (createContextBusStepTracer()/createSemanticFsStepTracer()/
   * createOtelStepTracer() itself) or a different backend entirely.
   */
  trace?: "full" | "otel" | StepTracer;
  /**
   * Wraps `computer.tools` through applyHumanApprovalGate() before
   * constructing the Agent — every gated tool call blocks on a human
   * decision via a running grants-server instance instead of executing
   * immediately. `requesterName` defaults to this Agent's own `name`. See
   * approval.ts.
   */
  humanApproval?: Omit<HumanApprovalGateOptions, "requesterName"> & { requesterName?: string };
  /**
   * "semantic-fs" builds a Retriever over this Computer's own
   * query_context/read_context_file tools (see createSemanticFsRetriever)
   * and adds it to the tool list as a single "search_context" tool — a real
   * retrieval call (query + content fetch in one round trip) instead of the
   * model having to chain the raw query_context/read_context_file exports
   * itself. Needs an app like apps/filesystem exposing those two exports, or
   * construction throws immediately. Pass a Retriever directly for a
   * different backend (a real vector DB, a plain grep).
   */
  retriever?: "semantic-fs" | Retriever;
  /**
   * Connects to one or more external MCP servers and adds their tools
   * alongside this Computer's own — the whole MCP tool ecosystem becomes
   * usable without writing a bespoke connector per integration. Each
   * connection stays open for the Agent's lifetime; `createAgent()`'s
   * returned `mcpServers` handles need `close()`ing when done (`runAgent()`
   * does this for you automatically, in `finally`, alongside `computer.stop()`).
   */
  mcpServers?: McpClientToolsOptions[];
  /** See AgentOptions.inputGuardrails. */
  inputGuardrails?: Guardrail[];
  /** See AgentOptions.outputGuardrails. */
  outputGuardrails?: Guardrail[];
}

function normalizeApps(apps: string | string[] | undefined): string[] {
  if (!apps) {
    throw new Error("createAgent() needs `apps` (a resident app directory, or an array of them), `connect`, or `computer`");
  }
  return typeof apps === "string" ? [apps] : apps;
}

/**
 * The one-call developer entry point: resolves a Computer (reuses one you
 * already built via `computer`, attaches to a shared `berth os up` instance
 * via `connect`, or boots a fresh one from `apps`) and wraps its tool list
 * into an Agent. `llm` defaults to whichever provider has an API key set.
 * `computer` is exposed directly too — call tools yourself, snapshot, or
 * `stop()` it when done. `mcpServers` is exposed as a separate array of live
 * connections (not folded into `computer`, which owns none of them) — close
 * each yourself, or use `runAgent()`, which does it for you.
 */
export async function createAgent(
  options: CreateAgentOptions,
): Promise<{ agent: Agent; computer: Computer; mcpServers: McpClientHandle[] }> {
  const computer =
    options.computer ??
    (options.connect
      ? await Computer.connect({
          ...(typeof options.connect === "string" ? { name: options.connect } : options.connect),
          docker: options.docker,
        })
      : await Computer.boot({
          apps: normalizeApps(options.apps),
          network: options.network,
          env: options.env,
          docker: options.docker,
          governance: options.governance,
        }));
  const checkpoint = options.checkpoint === "semantic-fs" ? createSemanticFsCheckpointStore(computer) : options.checkpoint;
  const trace =
    options.trace === "full" ? createAgentTracer(computer) : options.trace === "otel" ? createOtelStepTracer() : options.trace;
  const retriever = options.retriever === "semantic-fs" ? createSemanticFsRetriever(computer) : options.retriever;
  const mcpServers = options.mcpServers ? await Promise.all(options.mcpServers.map((server) => createMcpClientTools(server))) : [];
  const gatedTools = options.humanApproval
    ? applyHumanApprovalGate(computer.tools, {
        ...options.humanApproval,
        requesterName: options.humanApproval.requesterName ?? options.name ?? "agent",
      })
    : computer.tools;
  // MCP tools used to be concatenated *after* the governance gate, so a
  // governed Computer gated every resident-app tool and none of the MCP ones
  // — REMEDIATION.md 1.13. They don't reach the Computer's dispatch (they
  // talk to an external MCP server), so they're gated explicitly here, under
  // a synthetic app name: `mcp:<server>`, with the tool's own name as the
  // export. A governance app therefore sees MCP calls in the same
  // `{app, export, input}` shape as everything else, and the `mcp:` prefix
  // is what tells it this action leaves the sandbox entirely.
  const mcpTools = mcpServers.flatMap((server) => {
    const serverName = server.name;
    return server.tools.map((tool) =>
      computer.governance ? computer.governance.gateExternalTool(tool, { app: `mcp:${serverName}`, export: tool.name }) : tool,
    );
  });
  const tools = retriever ? [...gatedTools, ...mcpTools, retriever.asTool()] : [...gatedTools, ...mcpTools];

  const agent = new Agent({
    name: options.name,
    systemPrompt: options.systemPrompt,
    llm: resolveLLMProvider(options.llm),
    tools,
    maxTurns: options.maxTurns,
    checkpoint,
    trace,
    inputGuardrails: options.inputGuardrails,
    outputGuardrails: options.outputGuardrails,
    // So this agent's own asTool() delegation is gated too — the manager
    // that receives it need not know a governor exists.
    governance: computer.governance,
  });
  return { agent, computer, mcpServers };
}

export interface RunAgentOptions<T = never> extends Omit<CreateAgentOptions, "computer">, StructuredOutputRunOptions<T> {
  /** The task to hand the agent. */
  task: string;
  /**
   * Persists progress under this id when `checkpoint` is set. Note this
   * function always runs the task start-to-finish and tears the Computer
   * down in its own `finally` — resuming a run that crashed *during* a
   * runAgent() call means calling createAgent()+agent.resume(runId)
   * yourself against a Computer that's still around, not calling
   * runAgent() again.
   */
  runId?: string;
  /**
   * Called with each chunk of assistant text as the model produces it,
   * instead of only getting the full text back once run() resolves. Only
   * fires when the resolved `llm` provider implements `chatStream` (both
   * built-in providers do); silently has no effect otherwise.
   */
  onText?: (delta: string) => void;
}

/**
 * The dead-simple entry point for the common case — boot/connect, run one
 * task, clean up, all in one call:
 *
 *   const result = await runAgent({ apps: "apps/filesystem", task: "..." });
 *
 * `computer.stop()` is always safe to call here even when `connect` was
 * used: it's a no-op for a connected Computer (see Computer.stop()), so this
 * never tears down a shared `berth os up` instance out from under other runs.
 * Deliberately doesn't accept a pre-built `computer`: this function always
 * owns the Computer's whole lifecycle (create it, use it once, tear it
 * down/disconnect) — reusing one Computer across several calls needs
 * `createAgent({ computer })` instead, with `stop()` left to you.
 */
export async function runAgent<T = never>(options: RunAgentOptions<T>): Promise<AgentRunResult & { data?: T }> {
  const { task, runId, onText, responseSchema, maxRepairAttempts, ...createOptions } = options;
  const { agent, computer, mcpServers } = await createAgent(createOptions);
  try {
    return await agent.run(task, { runId, onText, responseSchema, maxRepairAttempts });
  } finally {
    await computer.stop();
    await Promise.all(mcpServers.map((server) => server.close()));
  }
}
