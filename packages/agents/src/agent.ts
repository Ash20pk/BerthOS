import { Computer, type BootComputerOptions, type ConnectComputerOptions } from "./computer.js";
import { resolveLLMProvider, type LLMProviderConfig } from "./providers/auto.js";
import { createSemanticFsCheckpointStore, type CheckpointedRun, type CheckpointStore } from "./checkpoint.js";
import { createAgentTracer, type StepTracer } from "./tracing.js";
import { applyHumanApprovalGate, type HumanApprovalGateOptions } from "./approval.js";
import { createSemanticFsRetriever, type Retriever } from "./retrieval.js";
import type { AgentMessage, LLMProvider, Tool } from "./types.js";

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
   * When set alongside `runId`, run()/resume() emit an AgentStepEvent after
   * every LLM turn and every tool call — turn number, duration, and error if
   * any. See tracing.ts. No `runId` means no events, same "constructor-level
   * seam, run-level activation" shape as `checkpoint`.
   */
  trace?: StepTracer;
}

export interface AgentRunResult {
  text: string;
  toolCalls: { name: string; input: unknown; result: unknown }[];
}

const DEFAULT_MAX_TURNS = 25;

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

  constructor(options: AgentOptions) {
    this.name = options.name ?? "agent";
    this.systemPrompt = options.systemPrompt;
    this.llm = options.llm;
    this.tools = options.tools;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.checkpointStore = options.checkpoint;
    this.tracer = options.trace;
  }

  async run(input: string, opts: { runId?: string; onText?: (delta: string) => void } = {}): Promise<AgentRunResult> {
    return this.loop([{ role: "user", text: input }], [], 0, opts.runId, opts.onText);
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
  async resume(runId: string, opts: { onText?: (delta: string) => void } = {}): Promise<AgentRunResult> {
    if (!this.checkpointStore) {
      throw new Error(`Agent "${this.name}" has no checkpoint store configured — pass { checkpoint } when constructing it to resume a run`);
    }
    const checkpoint = await this.checkpointStore.load(runId);
    if (!checkpoint) {
      throw new Error(`no checkpoint found for run "${runId}"`);
    }
    if (checkpoint.status === "done") {
      return { text: checkpoint.text ?? "", toolCalls: checkpoint.toolCalls };
    }
    return this.loop(checkpoint.messages, checkpoint.toolCalls, checkpoint.turnCount, runId, opts.onText);
  }

  private async loop(
    initialMessages: AgentMessage[],
    initialExecuted: AgentRunResult["toolCalls"],
    startTurn: number,
    runId: string | undefined,
    onText: ((delta: string) => void) | undefined,
  ): Promise<AgentRunResult> {
    const messages = [...initialMessages];
    const executed = [...initialExecuted];

    const checkpoint = async (turnCount: number, status: CheckpointedRun["status"], text?: string) => {
      if (!this.checkpointStore || !runId) return;
      await this.checkpointStore.save({ runId, agentName: this.name, status, turnCount, messages, toolCalls: executed, text });
    };

    const trace = async (event: Omit<Parameters<StepTracer["emit"]>[0], "runId" | "agentName">) => {
      if (!this.tracer || !runId) return;
      await this.tracer.emit({ ...event, runId, agentName: this.name });
    };

    for (let turnCount = startTurn; turnCount < this.maxTurns; turnCount++) {
      const turnStart = Date.now();
      let turn;
      try {
        turn =
          onText && this.llm.chatStream
            ? await this.llm.chatStream({ system: this.systemPrompt, messages, tools: this.tools }, onText)
            : await this.llm.chat({ system: this.systemPrompt, messages, tools: this.tools });
      } catch (err) {
        await trace({
          turn: turnCount,
          kind: "llm-turn",
          durationMs: Date.now() - turnStart,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      await trace({ turn: turnCount, kind: "llm-turn", durationMs: Date.now() - turnStart });

      if (turn.toolCalls.length === 0) {
        const text = turn.text ?? "";
        await checkpoint(turnCount, "done", text);
        return { text, toolCalls: executed };
      }

      messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });

      for (const call of turn.toolCalls) {
        const tool = this.tools.find((t) => t.name === call.name);
        const callStart = Date.now();
        let result: unknown;
        let error: string | undefined;
        if (!tool) {
          error = `no such tool "${call.name}"`;
          result = { error };
        } else {
          try {
            result = await tool.invoke(call.input);
          } catch (err) {
            // A failing tool call feeds an {error} result back to the model,
            // same as the "no such tool" case above, instead of throwing out
            // of the whole loop — the model gets a chance to retry with
            // different input, try another tool, or surface the failure
            // itself, rather than one bad call silently killing the run.
            error = err instanceof Error ? err.message : String(err);
            result = { error };
          }
        }
        await trace({ turn: turnCount, kind: "tool-call", toolName: call.name, durationMs: Date.now() - callStart, error });
        executed.push({ name: call.name, input: call.input, result });
        messages.push({ role: "tool", toolResult: { id: call.id, name: call.name, output: result } });
      }

      await checkpoint(turnCount + 1, "running");
    }

    await checkpoint(this.maxTurns, "error");
    throw new Error(`Agent "${this.name}" exceeded its maxTurns (${this.maxTurns}) without reaching a final answer`);
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
    });
  }

  /**
   * Wraps this agent as a Tool — {task: string} in, this.run(task).text out.
   * This is the "agent-as-tool" delegation pattern Crew.withManager() uses:
   * a manager agent's tool list can mix resident-app tools and other agents
   * through the exact same Tool.invoke() dispatch path.
   */
  asTool(description: string): Tool {
    return {
      name: this.name,
      description,
      inputSchema: {
        type: "object",
        properties: { task: { type: "string", description: "the task to delegate to this agent" } },
        required: ["task"],
      },
      invoke: async (input: unknown) => {
        const { task } = input as { task: string };
        const result = await this.run(task);
        return result.text;
      },
    };
  }
}

export interface CreateAgentOptions extends Pick<BootComputerOptions, "network" | "env" | "docker"> {
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
   * throws immediately. Pass a StepTracer directly for just one channel
   * (createContextBusStepTracer()/createSemanticFsStepTracer()) or a
   * different backend entirely.
   */
  trace?: "full" | StepTracer;
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
 * `stop()` it when done.
 */
export async function createAgent(options: CreateAgentOptions): Promise<{ agent: Agent; computer: Computer }> {
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
        }));
  const checkpoint = options.checkpoint === "semantic-fs" ? createSemanticFsCheckpointStore(computer) : options.checkpoint;
  const trace = options.trace === "full" ? createAgentTracer(computer) : options.trace;
  const retriever = options.retriever === "semantic-fs" ? createSemanticFsRetriever(computer) : options.retriever;
  const gatedTools = options.humanApproval
    ? applyHumanApprovalGate(computer.tools, {
        ...options.humanApproval,
        requesterName: options.humanApproval.requesterName ?? options.name ?? "agent",
      })
    : computer.tools;
  const tools = retriever ? [...gatedTools, retriever.asTool()] : gatedTools;

  const agent = new Agent({
    name: options.name,
    systemPrompt: options.systemPrompt,
    llm: resolveLLMProvider(options.llm),
    tools,
    maxTurns: options.maxTurns,
    checkpoint,
    trace,
  });
  return { agent, computer };
}

export interface RunAgentOptions extends Omit<CreateAgentOptions, "computer"> {
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
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const { task, runId, onText, ...createOptions } = options;
  const { agent, computer } = await createAgent(createOptions);
  try {
    return await agent.run(task, { runId, onText });
  } finally {
    await computer.stop();
  }
}
