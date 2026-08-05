import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import type { AgentMessage, LLMProvider, LLMTurn, Tool } from "../types.js";

export interface GoogleProviderOptions {
  apiKey?: string;
  /**
   * Uses Vertex AI instead of the Gemini API — needs `project`/`location`
   * (or their `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION` env var
   * equivalents) and Application Default Credentials instead of `apiKey`.
   */
  vertexai?: boolean;
  project?: string;
  location?: string;
  model?: string;
}

const DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * Gemini's FunctionResponse.response must be a JSON object (`Record<string,
 * unknown>`), unlike Anthropic/OpenAI's tool_result content, which accepts
 * any JSON value — a bare string/number/array tool output gets wrapped
 * under a "result" key rather than sent as-is, since the API would
 * otherwise reject it outright.
 */
function toFunctionResponseObject(output: unknown): Record<string, unknown> {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }
  return { result: output };
}

function toGoogleContents(messages: AgentMessage[]): Content[] {
  return messages.map((message): Content => {
    if (message.role === "user") {
      return { role: "user", parts: [{ text: message.text ?? "" }] };
    }
    if (message.role === "tool") {
      const result = message.toolResult;
      if (!result) throw new Error("AgentMessage with role 'tool' is missing toolResult");
      return {
        role: "user",
        parts: [{ functionResponse: { id: result.id, name: result.name, response: toFunctionResponseObject(result.output) } }],
      };
    }
    // role === "assistant"
    const parts: Part[] = [];
    if (message.text) parts.push({ text: message.text });
    for (const call of message.toolCalls ?? []) {
      parts.push({ functionCall: { id: call.id, name: call.name, args: call.input as Record<string, unknown> } });
    }
    return { role: "model", parts };
  });
}

function toFunctionDeclarations(tools: Tool[]): FunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    // Gemini accepts plain JSON Schema directly via parametersJsonSchema
    // (mutually exclusive with its own typed `parameters: Schema` field) —
    // no translation needed, same as Anthropic/OpenAI's inputSchema passthrough.
    parametersJsonSchema: t.inputSchema,
  }));
}

/**
 * Thin adapter over `@google/genai`'s `generateContent`/`generateContentStream`
 * — the third built-in LLMProvider, and the first non-Anthropic-shaped,
 * non-OpenAI-shaped one: Gemini's own Content/Part/FunctionCall/
 * FunctionResponse types are genuinely different from either, not just a
 * relabeling, which is what makes this a real test of whether Agent/Crew's
 * LLMProvider seam actually is vendor-neutral rather than accidentally
 * shaped around the two providers that came first.
 */
export function createGoogleProvider(options: GoogleProviderOptions = {}): LLMProvider {
  const client = new GoogleGenAI({
    apiKey: options.vertexai ? undefined : (options.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY),
    vertexai: options.vertexai,
    project: options.project,
    location: options.location,
  });
  const model = options.model ?? DEFAULT_MODEL;

  function usageFrom(usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined): LLMTurn["usage"] {
    if (!usageMetadata) return undefined;
    return { inputTokens: usageMetadata.promptTokenCount ?? 0, outputTokens: usageMetadata.candidatesTokenCount ?? 0 };
  }

  return {
    name: "google",
    async chat({ system, messages, tools }: { system?: string; messages: AgentMessage[]; tools: Tool[] }): Promise<LLMTurn> {
      const response = await client.models.generateContent({
        model,
        contents: toGoogleContents(messages),
        config: {
          systemInstruction: system,
          tools: tools.length > 0 ? [{ functionDeclarations: toFunctionDeclarations(tools) }] : undefined,
        },
      });

      const functionCalls = response.functionCalls ?? [];
      return {
        text: response.text,
        toolCalls: functionCalls.map((call, i) => ({ id: call.id ?? `call_${i}`, name: call.name ?? "", input: call.args ?? {} })),
        stop: functionCalls.length === 0,
        usage: usageFrom(response.usageMetadata),
      };
    },

    async chatStream(
      { system, messages, tools }: { system?: string; messages: AgentMessage[]; tools: Tool[] },
      onText: (delta: string) => void,
    ): Promise<LLMTurn> {
      const stream = await client.models.generateContentStream({
        model,
        contents: toGoogleContents(messages),
        config: {
          systemInstruction: system,
          tools: tools.length > 0 ? [{ functionDeclarations: toFunctionDeclarations(tools) }] : undefined,
        },
      });

      let text = "";
      // Unlike OpenAI, Gemini doesn't fragment a function call's JSON
      // arguments character-by-character across chunks — each chunk's own
      // `functionCalls`/`usageMetadata` getters already reflect that
      // chunk's complete state, so the last chunk that has them wins
      // (usage in particular is typically only present on the final chunk).
      let lastFunctionCalls: LLMTurn["toolCalls"] | undefined;
      let usage: LLMTurn["usage"];

      for await (const chunk of stream) {
        if (chunk.text) {
          text += chunk.text;
          onText(chunk.text);
        }
        const functionCalls = chunk.functionCalls;
        if (functionCalls && functionCalls.length > 0) {
          lastFunctionCalls = functionCalls.map((call, i) => ({ id: call.id ?? `call_${i}`, name: call.name ?? "", input: call.args ?? {} }));
        }
        if (chunk.usageMetadata) {
          usage = usageFrom(chunk.usageMetadata);
        }
      }

      const toolCalls = lastFunctionCalls ?? [];
      return {
        text: text || undefined,
        toolCalls,
        stop: toolCalls.length === 0,
        usage,
      };
    },
  };
}
