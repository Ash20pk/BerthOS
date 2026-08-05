/** The single interface a Computer's resident-app exports, and other Agents, both implement — see Agent.asTool(). */
export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: object;
  invoke(input: unknown): Promise<unknown>;
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

export interface LLMTurn {
  text?: string;
  toolCalls: { id: string; name: string; input: unknown }[];
  /** True once the model has nothing further to do — no pending tool calls. */
  stop: boolean;
  /** Token accounting for this one call, when the provider's API reports it. Absent, not zero, when a provider doesn't. */
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * The "bring your own LLM" seam. Any provider implementing this can drive an
 * Agent — @berth/agents ships createAnthropicProvider() and
 * createOpenAIProvider(), but nothing in Computer/Agent/Crew references a
 * specific vendor.
 */
export interface LLMProvider {
  readonly name: string;
  chat(params: { system?: string; messages: AgentMessage[]; tools: Tool[] }): Promise<LLMTurn>;
  /**
   * Same request/response contract as chat(), but calls onText(delta) for
   * each chunk of assistant text as the model produces it, instead of only
   * returning the full text once the turn is complete. Optional: a provider
   * that doesn't implement this can still drive an Agent exactly as before —
   * Agent.run()/resume() fall back to chat() when it's absent, simply
   * without incremental text events.
   */
  chatStream?(
    params: { system?: string; messages: AgentMessage[]; tools: Tool[] },
    onText: (delta: string) => void,
  ): Promise<LLMTurn>;
}
