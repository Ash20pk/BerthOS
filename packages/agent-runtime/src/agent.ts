import { Computer, type BootComputerOptions } from "./computer.js";
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

export interface CreateAgentOptions extends Pick<BootComputerOptions, "apps" | "network" | "docker"> {
  llm: LLMProvider;
  systemPrompt?: string;
  name?: string;
  maxTurns?: number;
}

/**
 * The one-call developer entry point: boots a Computer from the given
 * resident-app directories and wraps its tool list into an Agent driven by
 * any LLMProvider. `computer` is exposed directly too — call tools yourself,
 * snapshot, or `stop()` it when done.
 */
export async function createAgent(options: CreateAgentOptions): Promise<{ agent: Agent; computer: Computer }> {
  const computer = await Computer.boot({ apps: options.apps, network: options.network, docker: options.docker });
  const agent = new Agent({
    name: options.name,
    systemPrompt: options.systemPrompt,
    llm: options.llm,
    tools: computer.tools,
    maxTurns: options.maxTurns,
  });
  return { agent, computer };
}
