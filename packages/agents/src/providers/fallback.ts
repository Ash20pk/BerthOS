import type { LLMProvider } from "../types.js";

export interface FallbackProviderOptions {
  /**
   * Called once per provider that fails, right before falling through to
   * the next one in the chain — a hook for logging, not for deciding
   * whether to fall back (every error falls through; there's no
   * retriable-vs-not classification here, since createAnthropicProvider()/
   * createOpenAIProvider() already exhaust their own SDK-level retries
   * before ever throwing). Never called for the last provider — its error
   * propagates as-is instead.
   */
  onFallback?: (error: unknown, failedProvider: LLMProvider, nextProvider: LLMProvider) => void;
}

/**
 * Wraps an ordered list of LLMProviders into one primary/secondary/... model
 * chain: tries providers[0], and on any thrown error falls through to
 * providers[1], then providers[2], in order, until one succeeds or the last
 * one's error propagates unchanged. The layer above per-call retry, not a
 * replacement for it — createAnthropicProvider()/createOpenAIProvider() each
 * already retry a single flaky call a couple of times via their SDK client's
 * own maxRetries before this ever sees an error; this is for when a whole
 * provider is down (an outage, an exhausted quota), not one bad request.
 * Works with any LLMProvider, built-in or custom — nothing here references
 * Anthropic or OpenAI specifically.
 */
export function createFallbackProvider(providers: LLMProvider[], options: FallbackProviderOptions = {}): LLMProvider {
  if (providers.length === 0) {
    throw new Error("createFallbackProvider() needs at least one provider");
  }

  async function withFallback<T>(call: (provider: LLMProvider) => Promise<T>): Promise<T> {
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]!;
      try {
        return await call(provider);
      } catch (err) {
        const next = providers[i + 1];
        if (!next) throw err;
        options.onFallback?.(err, provider, next);
      }
    }
    throw new Error("unreachable");
  }

  return {
    name: `fallback(${providers.map((p) => p.name).join(" -> ")})`,
    chat: (params) => withFallback((provider) => provider.chat(params)),
    /**
     * Only present when every provider in the chain implements chatStream —
     * same "absent means no incremental events, not an error" contract
     * Agent.run() already treats chatStream as optional under. Falling back
     * mid-stream is a real, documented gap: onText may have already fired
     * with the failed provider's partial text before the switch, and the
     * next provider's stream starts over from nothing — see
     * docs/agents-reference.md.
     */
    ...(providers.every((p) => p.chatStream)
      ? {
          chatStream: (params, onText) => withFallback((provider) => provider.chatStream!(params, onText)),
        }
      : {}),
  };
}
