import Anthropic from "@anthropic-ai/sdk";
import type { AgentMessage, LLMProvider, LLMStopReason, LLMTurn, Tool } from "../types.js";

export interface AnthropicProviderOptions {
  apiKey?: string;
  /** Point at a custom endpoint (a self-hosted gateway, a Bedrock/Vertex proxy, ...) instead of Anthropic's default API. */
  baseURL?: string;
  model?: string;
  maxTokens?: number;
  /**
   * How many times the underlying @anthropic-ai/sdk client retries a single
   * call on a retriable error (429/5xx/timeout/connection error) with its
   * own exponential backoff, before chat()/chatStream() throw. The SDK
   * already defaults this to 2 — exposed here because that default was
   * previously invisible and unconfigurable from createAnthropicProvider().
   * For falling back to a *different* provider once this is exhausted, see
   * createFallbackProvider().
   */
  maxRetries?: number;
}

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 4096;

/**
 * The Messages API rejects any message whose content is an empty string or an
 * empty array ("all messages must have non-empty content"), and Agent.run()
 * can produce both: an assistant turn that carried neither text nor tool
 * calls, and a `{role:"assistant", text:""}` the responseSchema repair path
 * pushes directly. Such a message is dropped rather than filled in — a turn
 * with nothing in it carries no information, and inventing placeholder text
 * would attribute words to the model it never produced.
 *
 * The test keys on "no content at all", not "no text": an assistant turn with
 * tool calls and no narration is both legitimate and common, and dropping it
 * would break every tool-use loop. See REMEDIATION 3.6.
 */
function toAnthropicMessages(messages: AgentMessage[]): Anthropic.MessageParam[] {
  return messages.flatMap((message): Anthropic.MessageParam[] => {
    if (message.role === "user") {
      if (!message.text) return [];
      return [{ role: "user", content: message.text }];
    }
    if (message.role === "tool") {
      const result = message.toolResult;
      if (!result) throw new Error("AgentMessage with role 'tool' is missing toolResult");
      return [
        {
          role: "user",
          // JSON.stringify(undefined) is undefined, not a string — which would
          // be an empty content block, the very thing this function exists to
          // prevent. Normalize a missing output to JSON null instead.
          content: [{ type: "tool_result", tool_use_id: result.id, content: JSON.stringify(result.output ?? null) }],
        },
      ];
    }
    // role === "assistant"
    const content: Anthropic.ContentBlockParam[] = [];
    if (message.text) content.push({ type: "text", text: message.text });
    for (const call of message.toolCalls ?? []) {
      content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input as Record<string, unknown> });
    }
    if (content.length === 0) return [];
    return [{ role: "assistant", content }];
  });
}

/**
 * `max_tokens` is required by this API and defaults to 4096 above, so hitting
 * the cap is routine rather than exotic — and until REMEDIATION 3.2 nothing
 * read the field that says it happened. "pause_turn" is a long-running
 * server-tool turn the caller is meant to continue, not an ending, so it maps
 * to "other" rather than "end": Agent treats it as a normal turn, which is
 * the existing behaviour, instead of asserting a completion the model never
 * signalled.
 */
function toStopReason(stopReason: string | null | undefined): LLMStopReason | undefined {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "refusal";
    case null:
    case undefined:
      return undefined;
    default:
      return "other";
  }
}

/**
 * Thin adapter over @anthropic-ai/sdk's Messages API tool-use loop. One of
 * two built-in LLMProvider implementations proving the interface isn't
 * secretly hardcoded to one vendor — Agent/Crew never reference this module.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions = {}): LLMProvider {
  const client = new Anthropic({
    apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY,
    baseURL: options.baseURL,
    maxRetries: options.maxRetries,
  });
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
        stopReason: toStopReason(response.stop_reason),
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      };
    },

    async chatStream(
      { system, messages, tools }: { system?: string; messages: AgentMessage[]; tools: Tool[] },
      onText: (delta: string) => void,
    ): Promise<LLMTurn> {
      const stream = client.messages.stream({
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
      stream.on("text", (textDelta) => onText(textDelta));

      const response = await stream.finalMessage();
      const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
      const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

      return {
        text: textBlocks.map((b) => b.text).join("\n") || undefined,
        toolCalls: toolUseBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input })),
        stop: toolUseBlocks.length === 0,
        stopReason: toStopReason(response.stop_reason),
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      };
    },
  };
}
