"""Mirrors @berth/agents' structured-output.ts: parse a model's final answer
as JSON against a schema, and feed a corrective prompt back on failure.
Zod's schema/validation role is played by pydantic here — the closest
Python equivalent already used elsewhere in this repo (berth_sdk's own
manifest.py is pydantic-based too)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ValidationError


class StructuredOutputError(Exception):
    """Raised when Agent.run()/resume() exhausts its repair attempts without
    the model ever producing text that parses as JSON matching
    `response_schema` — `raw_text` is the model's last (still-invalid)
    attempt, for a caller that wants to log or salvage it."""

    def __init__(self, message: str, raw_text: str) -> None:
        super().__init__(message)
        self.raw_text = raw_text


def parse_structured_output(text: str, schema: type[BaseModel]) -> tuple[bool, Any, str | None]:
    """Parses `text` as JSON and validates it against `schema` (a pydantic
    BaseModel subclass). Returns (success, data, error) — data is the
    validated model instance on success, error is a human-readable string
    on failure. pydantic's `model_validate_json` already collapses "not
    valid JSON at all" and "valid JSON that doesn't match the schema" into
    the same ValidationError type (a `json_invalid` issue for the former),
    so both failure modes flow through one except branch here."""
    try:
        data = schema.model_validate_json(text)
    except ValidationError as err:
        return False, None, _format_validation_error(err)
    return True, data, None


def _format_validation_error(err: ValidationError) -> str:
    parts = []
    for issue in err.errors():
        if issue["type"] == "json_invalid":
            parts.append(f"response is not valid JSON: {issue['msg']}")
            continue
        loc = ".".join(str(p) for p in issue["loc"]) or "(root)"
        parts.append(f"{loc}: {issue['msg']}")
    return "; ".join(parts)


def format_tool_input_error(err: BaseException) -> str:
    """Reformats a pydantic ValidationError raised by a Tool's own invoke()
    into the same compact per-field shape parse_structured_output() already
    produces, instead of leaving the model to parse pydantic's own multi-line
    error text. Unlike formatToolInputError() in the TypeScript package
    (which detects a Zod-issues-shaped JSON string, because a resident-app
    export's validation error crosses an RPC wire and arrives as a plain
    string), every Tool here runs in-process — there's no wire boundary to
    strip the exception type off, so checking `isinstance` directly is both
    simpler and reliable, not a shortcut. Any other exception's `str()` is
    returned unchanged."""
    if isinstance(err, ValidationError):
        return _format_validation_error(err)
    return str(err)


def structured_output_repair_prompt(error: str) -> str:
    """The corrective nudge fed back to the model as a fresh user turn on a
    failed attempt."""
    return (
        f"Your previous response could not be parsed as valid JSON matching the required schema:\n{error}\n\n"
        "Respond again with ONLY corrected JSON matching the schema — no prose, no markdown code fences."
    )
