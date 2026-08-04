import pytest

from berth_agents import Agent, Crew, LLMTurn


class ScriptedLLM:
    name = "fake"

    def __init__(self, turns: list[LLMTurn]) -> None:
        self._turns = turns
        self._i = 0

    async def chat(self, *, system, messages, tools):
        turn = self._turns[self._i]
        self._i += 1
        return turn


def text_agent(name: str, output: str) -> Agent:
    return Agent(llm=ScriptedLLM([LLMTurn(text=output, tool_calls=[], stop=True)]), tools=[], name=name)


@pytest.mark.asyncio
async def test_sequential_chains_output_into_input_in_order():
    crew = Crew.sequential(
        [
            text_agent("first", "step one"),
            text_agent("second", "step two"),
            text_agent("third", "step three"),
        ]
    )

    result = await crew.run("start")

    assert result == "step three"


@pytest.mark.asyncio
async def test_sequential_returns_input_unchanged_for_an_empty_list():
    crew = Crew.sequential([])

    result = await crew.run("unchanged")

    assert result == "unchanged"
