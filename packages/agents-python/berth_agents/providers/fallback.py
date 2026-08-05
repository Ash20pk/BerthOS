"""Mirrors @berth/agents' providers/fallback.ts: wraps an ordered list of
LLMProviders into one primary/secondary/... model chain."""

from __future__ import annotations

from typing import Awaitable, Callable

from ..types import LLMProvider


def create_fallback_provider(
    providers: list[LLMProvider],
    *,
    on_fallback: Callable[[BaseException, LLMProvider, LLMProvider], None] | None = None,
) -> LLMProvider:
    """Tries providers[0], and on any raised exception falls through to
    providers[1], then providers[2], in order, until one succeeds or the
    last one's error propagates unchanged. The layer above per-call retry,
    not a replacement for it — create_anthropic_provider()/
    create_openai_provider() each already retry a single flaky call a
    couple of times via their SDK client's own max_retries before this ever
    sees an error; this is for when a whole provider is down (an outage, an
    exhausted quota), not one bad request. Works with any LLMProvider,
    built-in or custom."""
    if not providers:
        raise ValueError("create_fallback_provider() needs at least one provider")

    async def with_fallback(call: Callable[[LLMProvider], Awaitable]):
        for i, provider in enumerate(providers):
            try:
                return await call(provider)
            except Exception as err:  # noqa: BLE001 - re-raised once the chain is exhausted
                next_provider = providers[i + 1] if i + 1 < len(providers) else None
                if next_provider is None:
                    raise
                if on_fallback:
                    on_fallback(err, provider, next_provider)
        raise RuntimeError("unreachable")

    class _FallbackProvider:
        name = f"fallback({' -> '.join(p.name for p in providers)})"

        async def chat(self, **kwargs):
            return await with_fallback(lambda provider: provider.chat(**kwargs))

        async def chat_stream(self, **kwargs):
            # Only reachable when every provider in the chain has chat_stream —
            # Agent._loop() only looks this attribute up via getattr(), so it's
            # fine for this method to exist unconditionally here; a caller
            # that reaches it with a non-streaming provider mid-chain would
            # only find out at fallback time, same documented gap the
            # TypeScript version has: falling back mid-stream means on_text
            # may have already fired with the failed provider's partial text.
            return await with_fallback(lambda provider: provider.chat_stream(**kwargs))

    if not all(hasattr(p, "chat_stream") for p in providers):
        del _FallbackProvider.chat_stream

    return _FallbackProvider()
