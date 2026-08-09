import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { AgentMessage, LLMProvider, LLMTurn, Tool } from "../types.js";

export interface OpenAIProviderOptions {
  apiKey?: string;
  /** Point at a custom OpenAI-compatible endpoint (Ollama, vLLM, OpenRouter, Azure OpenAI, ...) instead of OpenAI's default API. */
  baseURL?: string;
  model?: string;
  /**
   * How many times the underlying `openai` client retries a single call on a
   * retriable error (429/5xx/timeout/connection error) with its own
   * exponential backoff, before chat()/chatStream() throw. The SDK already
   * defaults this to 2 — exposed here because that default was previously
   * invisible and unconfigurable from createOpenAIProvider(). For falling
   * back to a *different* provider once this is exhausted, see
   * createFallbackProvider().
   */
  maxRetries?: number;
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
      return { role: "tool", tool_call_id: result.id, content: JSON.stringify(result.output ?? null) };
    }
    // role === "assistant"
    return {
      role: "assistant",
      content: message.text ?? "",
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
 * loop. The second of the built-in LLMProvider implementations — proves the
 * Tool/LLMProvider seam is real (Agent/Crew never reference this module or
 * Anthropic's), not secretly single-vendor.
 */
export function createOpenAIProvider(options: OpenAIProviderOptions = {}): LLMProvider {
  const client = new OpenAI({
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
    baseURL: options.baseURL,
    maxRetries: options.maxRetries,
  });
  return createOpenAICompatibleProvider(client, options.model ?? DEFAULT_MODEL, "openai");
}

/**
 * The OpenAI API rejects `tools: []` outright — the key has to be absent, not
 * empty. That matters beyond tidiness: createLlmGuardrail() and llmJudge()
 * both call chat() with no tools at all, so every LLM-judge feature was
 * broken against OpenAI, Azure, Bedrock, and Ollama (all four share the
 * implementation below). Anthropic tolerates the empty array and google.ts
 * already guarded it, which is why this went unnoticed. Spread into the
 * request so the key simply doesn't exist rather than being set to
 * undefined. See REMEDIATION 3.1.
 */
function toolsParam(tools: Tool[]) {
  if (tools.length === 0) return {};
  return {
    tools: tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema as Record<string, unknown> },
    })),
  };
}

/**
 * The actual chat()/chatStream() implementation, shared by every provider
 * built on an `openai`-shaped client — `createOpenAIProvider()` above, and
 * `createAzureOpenAIProvider()`/`createBedrockProvider()`/
 * `createOllamaProvider()` (`azure-openai.ts`/`bedrock.ts`/`ollama.ts`),
 * which differ only in how the client itself is constructed (auth scheme,
 * base URL, deployment routing), never in the message-mapping or
 * tool-calling logic below. Not re-exported from `index.ts` — an
 * implementation detail those sibling files import directly, the same
 * "internal helper, not public API" posture `crew.ts`'s `checkpointKeyFor()`
 * already has.
 */
export function createOpenAICompatibleProvider(client: OpenAI, model: string, name: string): LLMProvider {
  return {
    name,
    async chat({ system, messages, tools }: { system?: string; messages: AgentMessage[]; tools: Tool[] }): Promise<LLMTurn> {
      const chatMessages: ChatCompletionMessageParam[] = system
        ? [{ role: "system", content: system }, ...toOpenAIMessages(messages)]
        : toOpenAIMessages(messages);

      const response = await client.chat.completions.create({
        model,
        messages: chatMessages,
        ...toolsParam(tools),
      });

      const choice = response.choices[0];
      const message = choice?.message;
      // We only ever advertise `type: "function"` tools above, so OpenAI never returns
      // the newer custom tool-call variant here — this narrows the union for the type checker.
      const toolCalls = (message?.tool_calls ?? [])
        .filter((call): call is Extract<typeof call, { type: "function" }> => call.type === "function")
        .map((call) => ({
          id: call.id,
          name: call.function.name,
          input: call.function.arguments ? JSON.parse(call.function.arguments) : {},
        }));

      return {
        text: message?.content ?? undefined,
        toolCalls,
        stop: toolCalls.length === 0,
        usage: response.usage
          ? { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens }
          : undefined,
      };
    },

    async chatStream(
      { system, messages, tools }: { system?: string; messages: AgentMessage[]; tools: Tool[] },
      onText: (delta: string) => void,
    ): Promise<LLMTurn> {
      const chatMessages: ChatCompletionMessageParam[] = system
        ? [{ role: "system", content: system }, ...toOpenAIMessages(messages)]
        : toOpenAIMessages(messages);

      const stream = await client.chat.completions.create({
        model,
        messages: chatMessages,
        ...toolsParam(tools),
        stream: true,
        // Without this, a streamed response never carries a usage field at
        // all (unlike the non-streamed chat() call, where it's always
        // present) — the one extra flag OpenAI's API needs to include it on
        // the final chunk.
        stream_options: { include_usage: true },
      });

      let text = "";
      // Tool-call deltas arrive fragmented across chunks, keyed by their position
      // in the response (not by id, which only shows up on the first fragment) —
      // accumulate each field until the stream ends.
      const toolCallsByIndex = new Map<number, { id?: string; name?: string; arguments: string }>();
      let usage: LLMTurn["usage"];

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          text += delta.content;
          onText(delta.content);
        }
        for (const toolCallDelta of delta?.tool_calls ?? []) {
          const acc = toolCallsByIndex.get(toolCallDelta.index) ?? { arguments: "" };
          if (toolCallDelta.id) acc.id = toolCallDelta.id;
          if (toolCallDelta.function?.name) acc.name = (acc.name ?? "") + toolCallDelta.function.name;
          if (toolCallDelta.function?.arguments) acc.arguments += toolCallDelta.function.arguments;
          toolCallsByIndex.set(toolCallDelta.index, acc);
        }
        if (chunk.usage) {
          usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
        }
      }

      const toolCalls = [...toolCallsByIndex.values()].map((acc) => ({
        id: acc.id ?? "",
        name: acc.name ?? "",
        input: acc.arguments ? JSON.parse(acc.arguments) : {},
      }));

      return {
        text: text || undefined,
        toolCalls,
        stop: toolCalls.length === 0,
        usage,
      };
    },
  };
}
