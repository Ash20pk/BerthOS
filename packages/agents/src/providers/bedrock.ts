import { BedrockOpenAI } from "openai/bedrock";
import type { LLMProvider } from "../types.js";
import { createOpenAICompatibleProvider } from "./openai.js";

export interface BedrockProviderOptions {
  /** Bedrock bearer token. Defaults to `AWS_BEARER_TOKEN_BEDROCK`. */
  apiKey?: string;
  /** AWS region used to derive the default Bedrock endpoint. Defaults to `AWS_REGION`/`AWS_DEFAULT_REGION`. */
  awsRegion?: string;
  /** Overrides the derived endpoint entirely. Defaults to `AWS_BEDROCK_BASE_URL`. */
  baseURL?: string;
  model?: string;
}

const DEFAULT_MODEL = "anthropic.claude-sonnet-5";

/**
 * Amazon Bedrock's newer OpenAI-compatible "Mantle" endpoint, via the
 * `openai` package's own `BedrockOpenAI` client (`openai/bedrock`,
 * bearer-token auth, not full AWS SigV4) — this is real, current Bedrock
 * support, not a workaround. A team already standardized on Bedrock (for
 * procurement, data-residency, or model-catalog reasons) can use it here
 * exactly like any other provider, sharing the same chat()/chatStream()
 * implementation every OpenAI-shaped provider in this file does.
 */
export function createBedrockProvider(options: BedrockProviderOptions = {}): LLMProvider {
  const client = new BedrockOpenAI({
    apiKey: options.apiKey,
    awsRegion: options.awsRegion,
    baseURL: options.baseURL,
  });
  return createOpenAICompatibleProvider(client, options.model ?? DEFAULT_MODEL, "bedrock");
}
