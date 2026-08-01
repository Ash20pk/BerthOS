import Anthropic from "@anthropic-ai/sdk";
import type { AgentMessage, LLMProvider, LLMTurn, Tool } from "../types.js";

export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 4096;

function toAnthropicMessages(messages: AgentMessage[]): Anthropic.MessageParam[] {
  return messages.map((message): Anthropic.MessageParam => {
    if (message.role === "user") {
      return { role: "user", content: message.text ?? "" };
    }
    if (message.role === "tool") {
      const result = message.toolResult;
      if (!result) throw new Error("AgentMessage with role 'tool' is missing toolResult");
      return {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: result.id, content: JSON.stringify(result.output) }],
      };
    }
    // role === "assistant"
    const content: Anthropic.MessageParam["content"] = [];
    if (message.text) content.push({ type: "text", text: message.text });
    for (const call of message.toolCalls ?? []) {
      content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input as Record<string, unknown> });
    }
    return { role: "assistant", content };
  });
}

/**
 * Thin adapter over @anthropic-ai/sdk's Messages API tool-use loop. One of
 * two built-in LLMProvider implementations proving the interface isn't
 * secretly hardcoded to one vendor — Agent/Crew never reference this module.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions = {}): LLMProvider {
  const client = new Anthropic({ apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY });
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  return {
    name: "anthropic",
    async chat({ system, messages, tools }: { system?: string; messages: AgentMessage[]; tools: Tool[] }): Promise<LLMTurn> {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: toAnthropicMessages(messages),
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
      });

      const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
      const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

      return {
        text: textBlocks.map((b) => b.text).join("\n") || undefined,
        toolCalls: toolUseBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input })),
        stop: toolUseBlocks.length === 0,
      };
    },
  };
}
