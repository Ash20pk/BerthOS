import { ProviderError, isAbortError } from "../errors.js";
import type { LLMProvider } from "../types.js";

export interface FallbackProviderOptions {
  /**
   * Called once per provider that fails, right before falling through to
   * the next one in the chain — a hook for logging. Never called for the
   * last provider (its error propagates as-is), and never called for an
   * error the chain deliberately doesn't fall through on — see
   * `shouldFallThrough` below.
   */
  onFallback?: (error: unknown, failedProvider: LLMProvider, nextProvider: LLMProvider) => void;
  /**
   * Overrides which errors fall through to the next provider. The default is
   * `err instanceof ProviderError ? err.retriable : true` — see the note on
   * `shouldFallThrough()` for why an unrecognized error still falls through.
   *
   * Cancellation is not overridable: an aborted call always propagates
   * immediately, whatever this returns. Honouring a `() => true` there would
   * mean `abort()` starts a call on the *next* provider, which is not a
   * policy anyone wants and not one worth the footgun of allowing.
   */
  shouldFallThrough?: (error: unknown, failedProvider: LLMProvider) => boolean;
}

/**
 * Whether an error is worth trying the next provider over — REMEDIATION 4.8.
 *
 * Before the taxonomy existed this was unconditionally `true`, because there
 * was nothing to branch on. Two costs came out of that. A malformed request
 * (an unknown model, a bad parameter) is rejected identically by every
 * provider in the chain, so the caller waited through N round trips to
 * receive the *last* provider's version of the same complaint. And an
 * oversized context did the same, when the actionable response is to send
 * less rather than to send the same thing elsewhere.
 *
 * An unclassified error still falls through, which keeps every chain that
 * worked before working: classification can only narrow this, never widen it.
 */
function shouldFallThrough(err: unknown): boolean {
  return err instanceof ProviderError ? err.retriable : true;
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
        // Checked before anything else, and not delegated to
        // shouldFallThrough: a cancelled call is the caller getting what they
        // asked for. Falling through would start a fresh request on the next
        // provider at the exact moment someone asked for no more requests.
        if (isAbortError(err)) throw err;
        const next = providers[i + 1];
        if (!next) throw err;
        if (!(options.shouldFallThrough ?? shouldFallThrough)(err, provider)) throw err;
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
