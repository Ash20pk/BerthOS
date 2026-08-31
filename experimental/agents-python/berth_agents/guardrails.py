"""`agent.py`'s governance-equivalent for the model's own input/output, not
tool calls (that's governance.ts, TypeScript-only, fail-closed by default
since REMEDIATION.md 1.11). A direct port of @berth/agents' guardrails.ts: a
`GuardrailResult.tripwire_triggered` of True halts the run via
GuardrailTripwireError — "tripwire" is the same term OpenAI's Agents SDK
guardrails use for the same concept, kept rather than inventing a different
name for an already familiar one."""

from __future__ import annotations

import inspect
import re
from dataclasses import dataclass
from typing import Awaitable, Callable, Literal, Union

from pydantic import BaseModel

from .structured_output import parse_structured_output
from .types import AgentMessage, LLMProvider

Stage = Literal["input", "output"]


@dataclass
class GuardrailResult:
    tripwire_triggered: bool
    # Required when tripwire_triggered is True — becomes
    # GuardrailTripwireError's message. Optional otherwise.
    message: str | None = None


Guardrail = Callable[[str], Union[GuardrailResult, Awaitable[GuardrailResult]]]


class GuardrailTripwireError(Exception):
    def __init__(self, stage: Stage, guardrail_message: str) -> None:
        self.stage = stage
        self.guardrail_message = guardrail_message
        super().__init__(f"{stage} guardrail tripped: {guardrail_message}")


async def run_guardrails(guardrails: list[Guardrail], text: str, stage: Stage) -> None:
    """Runs guardrails in order, stopping at the first tripped one — a cheap
    keyword check shouldn't wait on an expensive LLM-judge guardrail listed
    after it. Agent.run()/_loop() call this internally; exported for a
    caller that wants to guard something outside the tool-use loop entirely."""
    for guardrail in guardrails:
        result = guardrail(text)
        if inspect.isawaitable(result):
            result = await result
        if result.tripwire_triggered:
            raise GuardrailTripwireError(stage, result.message or "no reason given")


def create_keyword_guardrail(words: list[str], *, case_sensitive: bool = False) -> Guardrail:
    """Trips if any of `words` appears in the text — a cheap first line of
    defense, same "exact match, not fuzzy" posture eval.ts's containsText()
    has (not yet ported to berth_agents)."""
    normalized = words if case_sensitive else [w.lower() for w in words]

    def guardrail(text: str) -> GuardrailResult:
        haystack = text if case_sensitive else text.lower()
        hit = next((word for word in normalized if word in haystack), None)
        if hit:
            return GuardrailResult(tripwire_triggered=True, message=f'matched banned keyword "{hit}"')
        return GuardrailResult(tripwire_triggered=False)

    return guardrail


def create_regex_guardrail(pattern: str | re.Pattern[str], message: str | None = None) -> Guardrail:
    """Trips if `pattern` matches — the regex counterpart to
    create_keyword_guardrail(), for shapes a fixed word list can't express."""
    compiled = re.compile(pattern) if isinstance(pattern, str) else pattern
    default_message = message or f"matched pattern {compiled.pattern}"

    def guardrail(text: str) -> GuardrailResult:
        if compiled.search(text):
            return GuardrailResult(tripwire_triggered=True, message=default_message)
        return GuardrailResult(tripwire_triggered=False)

    return guardrail


class _GuardrailVerdict(BaseModel):
    tripwire_triggered: bool
    reason: str


def create_llm_guardrail(*, judge: LLMProvider, rubric: str) -> Guardrail:
    """The LLM-as-judge guardrail: asks `judge` whether the text violates
    `rubric`, for checks too fuzzy for a keyword/regex match. An
    unparseable judge response counts as a *tripped* guardrail (fail
    closed), not a passed one — a security gate that can't get a clear
    answer from its own judge shouldn't default to "safe.\""""

    async def guardrail(text: str) -> GuardrailResult:
        prompt = (
            "Evaluate the following text against this rubric. Trip the guardrail "
            f"(tripwire_triggered: true) only if the text violates it.\n\nRubric:\n{rubric}\n\n"
            f"Text:\n{text}\n\n"
            'Respond with ONLY JSON matching {"tripwire_triggered": boolean, "reason": string} '
            "— no prose, no markdown code fences."
        )
        turn = await judge.chat(system=None, messages=[AgentMessage(role="user", text=prompt)], tools=[])
        success, data, error = parse_structured_output(turn.text or "", _GuardrailVerdict)
        if not success:
            return GuardrailResult(
                tripwire_triggered=True,
                message=f"guardrail judge response could not be parsed: {error}",
            )
        return GuardrailResult(tripwire_triggered=data.tripwire_triggered, message=data.reason)

    return guardrail
