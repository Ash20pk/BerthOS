import OpenAI from "openai";
import type { LLMProvider } from "../types.js";
import { createOpenAICompatibleProvider } from "./openai.js";

export interface OllamaProviderOptions {
  /** Defaults to Ollama's default local server address. */
  baseURL?: string;
  model?: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_MODEL = "llama3.1";

/**
 * `createOpenAIProvider({ baseURL: "http://127.0.0.1:11434/v1" })` already
 * works — Ollama speaks the OpenAI Chat Completions API — so this is pure
 * ergonomics: a real local-model default and a name that says what it is,
 * the same reason a dedicated `ollama` provider exists in every other
 * framework's provider list even though it's technically "just OpenAI
 * pointed somewhere else" underneath. Ollama's own server ignores
 * authentication entirely, but the `openai` client still requires a
 * non-empty `apiKey` string to construct — `"ollama"` is the placeholder
 * the Ollama project's own docs suggest for exactly this reason.
 */
export function createOllamaProvider(options: OllamaProviderOptions = {}): LLMProvider {
  const client = new OpenAI({ apiKey: "ollama", baseURL: options.baseURL ?? DEFAULT_BASE_URL });
  return createOpenAICompatibleProvider(client, options.model ?? DEFAULT_MODEL, "ollama");
}
