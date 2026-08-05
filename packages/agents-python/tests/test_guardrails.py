import pytest

from berth_agents import (
    GuardrailResult,
    GuardrailTripwireError,
    create_keyword_guardrail,
    create_llm_guardrail,
    create_regex_guardrail,
    run_guardrails,
)
from berth_agents.types import LLMTurn


@pytest.mark.asyncio
async def test_run_guardrails_does_nothing_when_every_guardrail_passes():
    await run_guardrails(
        [lambda text: GuardrailResult(tripwire_triggered=False), lambda text: GuardrailResult(tripwire_triggered=False)],
        "harmless text",
        "input",
    )


@pytest.mark.asyncio
async def test_run_guardrails_raises_a_guardrail_tripwire_error_carrying_the_stage_and_message():
    with pytest.raises(GuardrailTripwireError) as excinfo:
        await run_guardrails(
            [lambda text: GuardrailResult(tripwire_triggered=True, message="nope")], "text", "output"
        )
    assert excinfo.value.stage == "output"
    assert excinfo.value.guardrail_message == "nope"


@pytest.mark.asyncio
async def test_a_tripped_guardrail_with_no_message_still_raises_a_usable_error():
    with pytest.raises(GuardrailTripwireError, match="no reason given"):
        await run_guardrails([lambda text: GuardrailResult(tripwire_triggered=True)], "text", "input")


def test_create_keyword_guardrail_trips_on_a_case_insensitive_substring_match_by_default():
    guardrail = create_keyword_guardrail(["forbidden"])
    result = guardrail("this text is FORBIDDEN here")
    assert result.tripwire_triggered is True
    assert "forbidden" in result.message


def test_create_keyword_guardrail_does_not_trip_when_case_sensitive_and_case_differs():
    guardrail = create_keyword_guardrail(["forbidden"], case_sensitive=True)
    result = guardrail("this text is FORBIDDEN here")
    assert result.tripwire_triggered is False


def test_create_keyword_guardrail_passes_clean_text():
    guardrail = create_keyword_guardrail(["forbidden"])
    result = guardrail("this text is fine")
    assert result.tripwire_triggered is False


def test_create_regex_guardrail_trips_on_a_pattern_match_with_a_custom_message():
    guardrail = create_regex_guardrail(r"\d{3}-\d{2}-\d{4}", "looked like an SSN")
    result = guardrail("my number is 123-45-6789")
    assert result.tripwire_triggered is True
    assert result.message == "looked like an SSN"


def test_create_regex_guardrail_passes_text_that_does_not_match():
    guardrail = create_regex_guardrail(r"\d{3}-\d{2}-\d{4}")
    result = guardrail("no numbers here")
    assert result.tripwire_triggered is False


class FakeJudge:
    name = "fake-judge"

    def __init__(self, response_text: str) -> None:
        self._response_text = response_text

    async def chat(self, *, system, messages, tools):
        return LLMTurn(text=self._response_text, tool_calls=[], stop=True)


@pytest.mark.asyncio
async def test_create_llm_guardrail_trips_when_the_judge_says_so():
    guardrail = create_llm_guardrail(
        judge=FakeJudge('{"tripwire_triggered": true, "reason": "violates rubric"}'), rubric="no profanity"
    )
    result = await guardrail("some text")
    assert result.tripwire_triggered is True
    assert result.message == "violates rubric"


@pytest.mark.asyncio
async def test_create_llm_guardrail_passes_when_the_judge_says_so():
    guardrail = create_llm_guardrail(
        judge=FakeJudge('{"tripwire_triggered": false, "reason": "looks fine"}'), rubric="no profanity"
    )
    result = await guardrail("some text")
    assert result.tripwire_triggered is False


@pytest.mark.asyncio
async def test_create_llm_guardrail_fails_closed_when_the_judges_response_cannot_be_parsed():
    guardrail = create_llm_guardrail(judge=FakeJudge("not json at all"), rubric="no profanity")
    result = await guardrail("some text")
    assert result.tripwire_triggered is True
    assert "could not be parsed" in result.message
