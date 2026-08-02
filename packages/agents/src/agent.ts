import { Computer, type BootComputerOptions, type ConnectComputerOptions } from "./computer.js";
import { resolveLLMProvider, type LLMProviderConfig } from "./providers/auto.js";
import type { AgentMessage, LLMProvider, Tool } from "./types.js";

export interface AgentOptions {
  name?: string;
  systemPrompt?: string;
  llm: LLMProvider;
  tools: Tool[];
  /** Safety cap on the tool-use loop, in case a provider never stops requesting tool calls. */
  maxTurns?: number;
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

  constructor(options: AgentOptions) {
    this.name = options.name ?? "agent";
    this.systemPrompt = options.systemPrompt;
    this.llm = options.llm;
    this.tools = options.tools;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  }

  async run(input: string): Promise<AgentRunResult> {
    const messages: AgentMessage[] = [{ role: "user", text: input }];
    const executed: AgentRunResult["toolCalls"] = [];

    for (let turnCount = 0; turnCount < this.maxTurns; turnCount++) {
      const turn = await this.llm.chat({ system: this.systemPrompt, messages, tools: this.tools });

      if (turn.toolCalls.length === 0) {
        return { text: turn.text ?? "", toolCalls: executed };
      }

      messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });

      for (const call of turn.toolCalls) {
        const tool = this.tools.find((t) => t.name === call.name);
        const result: unknown = tool ? await tool.invoke(call.input) : { error: `no such tool "${call.name}"` };
        executed.push({ name: call.name, input: call.input, result });
        messages.push({ role: "tool", toolResult: { id: call.id, name: call.name, output: result } });
      }
    }

    throw new Error(`Agent "${this.name}" exceeded its maxTurns (${this.maxTurns}) without reaching a final answer`);
  }

  /**
   * Returns a new Agent with the same identity/llm/systemPrompt but an
   * extended tool list — used by Crew.withManager() to give a manager agent
   * one Tool per worker (via worker.asTool()) without mutating either agent.
   */
  withTools(extraTools: Tool[]): Agent {
    return new Agent({
      name: this.name,
      systemPrompt: this.systemPrompt,
      llm: this.llm,
      tools: [...this.tools, ...extraTools],
      maxTurns: this.maxTurns,
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
  const agent = new Agent({
    name: options.name,
    systemPrompt: options.systemPrompt,
    llm: resolveLLMProvider(options.llm),
    tools: computer.tools,
    maxTurns: options.maxTurns,
  });
  return { agent, computer };
}

export interface RunAgentOptions extends Omit<CreateAgentOptions, "computer"> {
  /** The task to hand the agent. */
  task: string;
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
  const { task, ...createOptions } = options;
  const { agent, computer } = await createAgent(createOptions);
  try {
    return await agent.run(task);
  } finally {
    await computer.stop();
  }
}
