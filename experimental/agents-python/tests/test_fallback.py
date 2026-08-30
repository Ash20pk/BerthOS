import pytest

from berth_agents import LLMTurn, create_fallback_provider

PARAMS = {"system": None, "messages": [], "tools": []}


class FakeProvider:
    def __init__(self, name, chat, chat_stream=None):
        self.name = name
        self.chat = chat
        if chat_stream is not None:
            self.chat_stream = chat_stream


def always_succeeds(name: str, turn: LLMTurn) -> FakeProvider:
    async def chat(**_kwargs):
        return turn

    return FakeProvider(name, chat)


def always_throws(name: str, message: str) -> FakeProvider:
    async def chat(**_kwargs):
        raise RuntimeError(message)

    return FakeProvider(name, chat)


def test_throws_immediately_when_given_an_empty_provider_list():
    with pytest.raises(ValueError, match="at least one provider"):
        create_fallback_provider([])


@pytest.mark.asyncio
async def test_chat_uses_the_first_provider_when_it_succeeds_never_touching_the_rest():
    second_called = False

    async def second_chat(**_kwargs):
        nonlocal second_called
        second_called = True
        return LLMTurn(text="from second", tool_calls=[], stop=True)

    first = always_succeeds("first", LLMTurn(text="from first", tool_calls=[], stop=True))
    second = FakeProvider("second", second_chat)

    provider = create_fallback_provider([first, second])
    turn = await provider.chat(**PARAMS)

    assert turn.text == "from first"
    assert second_called is False


@pytest.mark.asyncio
async def test_chat_falls_through_to_the_next_provider_when_the_first_throws():
    first = always_throws("first", "rate limited")
    second = always_succeeds("second", LLMTurn(text="from second", tool_calls=[], stop=True))

    provider = create_fallback_provider([first, second])
    turn = await provider.chat(**PARAMS)

    assert turn.text == "from second"


@pytest.mark.asyncio
async def test_chat_falls_through_multiple_failing_providers_before_succeeding():
    first = always_throws("first", "down")
    second = always_throws("second", "also down")
    third = always_succeeds("third", LLMTurn(text="from third", tool_calls=[], stop=True))

    provider = create_fallback_provider([first, second, third])
    turn = await provider.chat(**PARAMS)

    assert turn.text == "from third"


@pytest.mark.asyncio
async def test_chat_propagates_the_last_providers_error_once_every_provider_has_failed():
    first = always_throws("first", "down")
    second = always_throws("second", "also down")

    provider = create_fallback_provider([first, second])

    with pytest.raises(RuntimeError, match="also down"):
        await provider.chat(**PARAMS)


@pytest.mark.asyncio
async def test_on_fallback_fires_once_per_failed_provider_never_for_the_last():
    first = always_throws("first", "down")
    second = always_throws("second", "also down")
    third = always_succeeds("third", LLMTurn(text="ok", tool_calls=[], stop=True))
    calls = []

    provider = create_fallback_provider(
        [first, second, third],
        on_fallback=lambda _err, failed, nxt: calls.append({"failed": failed.name, "next": nxt.name}),
    )
    await provider.chat(**PARAMS)

    assert calls == [{"failed": "first", "next": "second"}, {"failed": "second", "next": "third"}]


def test_name_lists_every_provider_in_order():
    provider = create_fallback_provider(
        [
            always_succeeds("a", LLMTurn(tool_calls=[], stop=True)),
            always_succeeds("b", LLMTurn(tool_calls=[], stop=True)),
        ]
    )

    assert provider.name == "fallback(a -> b)"


@pytest.mark.asyncio
async def test_chat_stream_is_present_when_every_provider_implements_it():
    async def first_stream(**_kwargs):
        raise RuntimeError("stream down")

    async def second_stream(*, on_text, **_kwargs):
        on_text("hi")
        return LLMTurn(text="hi", tool_calls=[], stop=True)

    first = FakeProvider("first", chat=always_throws("first", "unused").chat, chat_stream=first_stream)
    second = FakeProvider("second", chat=always_throws("second", "unused").chat, chat_stream=second_stream)

    provider = create_fallback_provider([first, second])
    assert hasattr(provider, "chat_stream")

    seen = []
    turn = await provider.chat_stream(**PARAMS, on_text=seen.append)

    assert seen == ["hi"]
    assert turn.text == "hi"


def test_chat_stream_is_absent_when_any_provider_in_the_chain_lacks_it():
    first = always_succeeds("first", LLMTurn(tool_calls=[], stop=True))  # no chat_stream

    async def second_stream(*, on_text, **_kwargs):
        on_text("x")
        return LLMTurn(tool_calls=[], stop=True)

    second = FakeProvider("second", chat=first.chat, chat_stream=second_stream)

    provider = create_fallback_provider([first, second])

    assert not hasattr(provider, "chat_stream")
