import { AzureOpenAI } from "openai";
import type { LLMProvider } from "../types.js";
import { createOpenAICompatibleProvider } from "./openai.js";

export interface AzureOpenAIProviderOptions {
  apiKey?: string;
  /** Your Azure OpenAI resource endpoint, e.g. `https://<resource>.openai.azure.com`. Defaults to `AZURE_OPENAI_ENDPOINT`. */
  endpoint?: string;
  /** The deployment name you created in Azure (not the underlying model's own name) — Azure routes by deployment, not by `model` in the request body. Defaults to `AZURE_OPENAI_DEPLOYMENT`. */
  deployment?: string;
  /** Azure's API version query param. Defaults to `AZURE_OPENAI_API_VERSION`, or a recent stable version if neither is set. */
  apiVersion?: string;
}

const DEFAULT_API_VERSION = "2024-10-21";

/**
 * Azure OpenAI isn't just OpenAI with a different `baseURL` — it authenticates
 * with an `api-key` header (or Entra ID) instead of `Authorization: Bearer`,
 * routes by a deployment name in the URL path rather than `model` in the
 * request body, and requires an `api-version` query param on every request.
 * The `openai` package's own `AzureOpenAI` client (re-exported from its main
 * entrypoint) already handles all three; this just wires it into the same
 * chat()/chatStream() implementation every other OpenAI-shaped provider
 * shares (see `createOpenAICompatibleProvider()` in `openai.ts`).
 */
export function createAzureOpenAIProvider(options: AzureOpenAIProviderOptions = {}): LLMProvider {
  const deployment = options.deployment ?? process.env.AZURE_OPENAI_DEPLOYMENT;
  if (!deployment) {
    throw new Error("createAzureOpenAIProvider() needs `deployment` (or AZURE_OPENAI_DEPLOYMENT) — Azure routes by deployment name, not model");
  }
  const client = new AzureOpenAI({
    apiKey: options.apiKey ?? process.env.AZURE_OPENAI_API_KEY,
    endpoint: options.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT,
    deployment,
    apiVersion: options.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? DEFAULT_API_VERSION,
  });
  // Azure's chat.completions.create() ignores `model` in favor of the
  // client's configured deployment, but the field is still required by the
  // SDK's own types — the deployment name is a reasonable value to send.
  return createOpenAICompatibleProvider(client, deployment, "azure-openai");
}
