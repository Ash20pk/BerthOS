from pydantic import BaseModel, ValidationError

from berth_agents.structured_output import (
    format_tool_input_error,
    parse_structured_output,
    structured_output_repair_prompt,
)


class Answer(BaseModel):
    label: str
    confidence: float


def test_parse_structured_output_succeeds_on_matching_json():
    success, data, error = parse_structured_output('{"label": "cat", "confidence": 0.9}', Answer)

    assert success is True
    assert data == Answer(label="cat", confidence=0.9)
    assert error is None


def test_parse_structured_output_reports_invalid_json():
    success, data, error = parse_structured_output("not json at all", Answer)

    assert success is False
    assert data is None
    assert "not valid JSON" in error


def test_parse_structured_output_reports_a_schema_mismatch_per_field():
    success, data, error = parse_structured_output('{"label": "cat"}', Answer)

    assert success is False
    assert "confidence" in error


def test_format_tool_input_error_reformats_a_real_validation_error():
    try:
        Answer.model_validate({"label": "cat"})
    except ValidationError as err:
        message = format_tool_input_error(err)

    assert "confidence" in message


def test_format_tool_input_error_passes_a_plain_error_through_unchanged():
    message = format_tool_input_error(RuntimeError("boom"))

    assert message == "boom"


def test_structured_output_repair_prompt_includes_the_error():
    prompt = structured_output_repair_prompt("confidence: field required")

    assert "confidence: field required" in prompt
    assert "ONLY corrected JSON" in prompt
