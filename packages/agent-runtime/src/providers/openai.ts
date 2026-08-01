import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { AgentMessage, LLMProvider, LLMTurn, Tool } from "../types.js";

export interface OpenAIProviderOptions {
  apiKey?: string;
  model?: string;
}

const DEFAULT_MODEL = "gpt-4o";

function toOpenAIMessages(messages: AgentMessage[]): ChatCompletionMessageParam[] {
  return messages.map((message): ChatCompletionMessageParam => {
    if (message.role === "user") {
      return { role: "user", content: message.text ?? "" };
    }
    if (message.role === "tool") {
      const result = message.toolResult;
      if (!result) throw new Error("AgentMessage with role 'tool' is missing toolResult");
      return { role: "tool", tool_call_id: result.id, content: JSON.stringify(result.output) };
    }
    // role === "assistant"
    return {
      role: "assistant",
      content: message.text ?? null,
      tool_calls: message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      })),
    };
  });
}

/**
 * Thin adapter over the `openai` package's Chat Completions tool-calling
 * loop. The second of two built-in LLMProvider implementations — proves the
 * Tool/LLMProvider seam is real (Agent/Crew never reference this module or
 * Anthropic's), not secretly single-vendor.
 */
export function createOpenAIProvider(options: OpenAIProviderOptions = {}): LLMProvider {
  const client = new OpenAI({ apiKey: options.apiKey ?? process.env.OPENAI_API_KEY });
  const model = options.model ?? DEFAULT_MODEL;

  return {
    name: "openai",
    async chat({ system, messages, tools }: { system?: string; messages: AgentMessage[]; tools: Tool[] }): Promise<LLMTurn> {
      const chatMessages: ChatCompletionMessageParam[] = system
        ? [{ role: "system", content: system }, ...toOpenAIMessages(messages)]
        : toOpenAIMessages(messages);

      const response = await client.chat.completions.create({
        model,
        messages: chatMessages,
        tools: tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.inputSchema as Record<string, unknown> },
        })),
      });

      const choice = response.choices[0];
      const message = choice?.message;
      const toolCalls = (message?.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        input: call.function.arguments ? JSON.parse(call.function.arguments) : {},
      }));

      return {
        text: message?.content ?? undefined,
        toolCalls,
        stop: toolCalls.length === 0,
      };
    },
  };
}
