import type { LLMProvider } from "../types.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createGoogleProvider } from "./google.js";
import { createOllamaProvider } from "./ollama.js";
import { createOpenAIProvider } from "./openai.js";

/**
 * Picks whichever LLMProvider has a real API key sitting in the environment,
 * so `createAgent()`/`runAgent()` can work with zero explicit LLM wiring for
 * the common case — a dev with one provider's key exported doesn't have to
 * know which `createXProvider()` function matches it. Checked in the order
 * they're listed in this repo's own docs/README, not because of any
 * functional preference. Azure OpenAI/Bedrock/Ollama aren't auto-detected —
 * each needs more than an API key (a deployment name, an AWS region, a
 * local server address) to construct correctly, so those stay explicit.
 */
export function detectLLMProvider(): LLMProvider {
  if (process.env.ANTHROPIC_API_KEY) return createAnthropicProvider();
  if (process.env.OPENAI_API_KEY) return createOpenAIProvider();
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) return createGoogleProvider();
  throw new Error(
    "no LLM provider could be auto-detected — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY/GEMINI_API_KEY, " +
      "or pass `llm: createAnthropicProvider()` / `createOpenAIProvider()` / `createGoogleProvider()` / " +
      "`createAzureOpenAIProvider()` / `createBedrockProvider()` / `createOllamaProvider()` / your own LLMProvider explicitly",
  );
}

/**
 * A plain-data alternative to constructing a provider yourself — lets
 * `createAgent({ llm: {...} })` describe a custom endpoint (a self-hosted
 * gateway, OpenRouter, a Vertex proxy) without an extra `import {
 * createOpenAIProvider }` line. Unlike `network.ts`'s `AgentServerLLMConfig`
 * (which takes an env var *name*, because it has to survive being
 * serialized into a synthesized resident app's source), `apiKey`/`baseURL`
 * here are real values — this is an in-process convenience, not something
 * that crosses a process boundary. Azure OpenAI and Bedrock aren't
 * representable in this shape (a deployment name, an AWS region) — use
 * `createAzureOpenAIProvider()`/`createBedrockProvider()` directly for those.
 */
export interface LLMProviderConfig {
  provider: "anthropic" | "openai" | "google" | "ollama";
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

function isLLMProvider(value: LLMProvider | LLMProviderConfig): value is LLMProvider {
  return typeof (value as Partial<LLMProvider>).chat === "function";
}

/** Resolves `createAgent()`/`runAgent()`'s `llm` option: a real LLMProvider passes through untouched, a config object is built into one, and `undefined` auto-detects. */
export function resolveLLMProvider(llm: LLMProvider | LLMProviderConfig | undefined): LLMProvider {
  if (!llm) return detectLLMProvider();
  if (isLLMProvider(llm)) return llm;
  if (llm.provider === "anthropic") return createAnthropicProvider({ apiKey: llm.apiKey, baseURL: llm.baseURL, model: llm.model });
  if (llm.provider === "openai") return createOpenAIProvider({ apiKey: llm.apiKey, baseURL: llm.baseURL, model: llm.model });
  if (llm.provider === "google") return createGoogleProvider({ apiKey: llm.apiKey, model: llm.model });
  if (llm.provider === "ollama") return createOllamaProvider({ baseURL: llm.baseURL, model: llm.model });
  throw new Error(`llm.provider must be one of "anthropic"/"openai"/"google"/"ollama" — got ${JSON.stringify((llm as LLMProviderConfig).provider)}`);
}
