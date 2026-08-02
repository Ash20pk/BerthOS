import type { LLMProvider } from "../types.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";

/**
 * Picks whichever LLMProvider has a real API key sitting in the environment,
 * so `createAgent()`/`runAgent()` can work with zero explicit LLM wiring for
 * the common case — a dev with one provider's key exported doesn't have to
 * know which `createXProvider()` function matches it. Anthropic is checked
 * first only because it's listed first in this repo's own docs/README, not
 * because of any functional preference between the two.
 */
export function detectLLMProvider(): LLMProvider {
  if (process.env.ANTHROPIC_API_KEY) return createAnthropicProvider();
  if (process.env.OPENAI_API_KEY) return createOpenAIProvider();
  throw new Error(
    "no LLM provider could be auto-detected — set ANTHROPIC_API_KEY or OPENAI_API_KEY, or pass `llm: createAnthropicProvider()` / `createOpenAIProvider()` / your own LLMProvider explicitly",
  );
}

/**
 * A plain-data alternative to constructing a provider yourself — lets
 * `createAgent({ llm: {...} })` describe a custom endpoint (a self-hosted
 * gateway, Ollama/vLLM, OpenRouter, a Bedrock/Vertex proxy) without an extra
 * `import { createOpenAIProvider }` line. Unlike `network.ts`'s
 * `AgentServerLLMConfig` (which takes an env var *name*, because it has to
 * survive being serialized into a synthesized resident app's source),
 * `apiKey`/`baseURL` here are real values — this is an in-process
 * convenience, not something that crosses a process boundary.
 */
export interface LLMProviderConfig {
  provider: "anthropic" | "openai";
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
  throw new Error(`llm.provider must be "anthropic" or "openai" — got ${JSON.stringify((llm as LLMProviderConfig).provider)}`);
}
