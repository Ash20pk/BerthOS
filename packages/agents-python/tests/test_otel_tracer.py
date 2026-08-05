import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from berth_agents import Agent, LLMTurn, ToolCall, Usage, create_otel_step_tracer


_EXPORTER = InMemorySpanExporter()
_provider = TracerProvider()
_provider.add_span_processor(SimpleSpanProcessor(_EXPORTER))
# opentelemetry-api only allows the global TracerProvider to be set once per
# process — trace.get_tracer() calls made by OtelStepTracer instances created
# in different tests all resolve against this same registration, so the
# pipeline is built once at import time rather than per-test.
trace.set_tracer_provider(_provider)


@pytest.fixture
def otel_exporter():
    _EXPORTER.clear()
    yield _EXPORTER


@pytest.mark.asyncio
async def test_emits_a_real_span_for_an_llm_turn_event_with_genai_attributes(otel_exporter):
    tracer = create_otel_step_tracer()
    from berth_agents.tracing import AgentStepEvent

    await tracer.emit(
        AgentStepEvent(
            run_id="run-1", agent_name="my-agent", turn=0, kind="llm-turn", duration_ms=150,
            usage=Usage(input_tokens=10, output_tokens=5),
        )
    )

    spans = otel_exporter.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    assert span.name == "chat my-agent"
    assert span.attributes["gen_ai.operation.name"] == "chat"
    assert span.attributes["gen_ai.agent.name"] == "my-agent"
    assert span.attributes["berth.run_id"] == "run-1"
    assert span.attributes["berth.turn"] == 0
    assert span.attributes["gen_ai.usage.input_tokens"] == 10
    assert span.attributes["gen_ai.usage.output_tokens"] == 5
    assert span.status.status_code == StatusCode.OK


@pytest.mark.asyncio
async def test_emits_a_real_span_for_a_tool_call_event(otel_exporter):
    from berth_agents.tracing import AgentStepEvent

    tracer = create_otel_step_tracer()
    await tracer.emit(
        AgentStepEvent(run_id="run-1", agent_name="my-agent", turn=1, kind="tool-call", tool_name="search", duration_ms=42)
    )

    span = otel_exporter.get_finished_spans()[0]
    assert span.name == "execute_tool search"
    assert span.attributes["gen_ai.operation.name"] == "execute_tool"
    assert span.attributes["gen_ai.tool.name"] == "search"


@pytest.mark.asyncio
async def test_records_an_error_status_and_exception(otel_exporter):
    from berth_agents.tracing import AgentStepEvent

    tracer = create_otel_step_tracer()
    await tracer.emit(
        AgentStepEvent(run_id="run-1", agent_name="a", turn=0, kind="tool-call", tool_name="boom", duration_ms=5, error="kaboom")
    )

    span = otel_exporter.get_finished_spans()[0]
    assert span.status.status_code == StatusCode.ERROR
    assert span.status.description == "kaboom"
    assert any(event.name == "exception" for event in span.events)


@pytest.mark.asyncio
async def test_agent_run_emits_trace_events_for_a_tool_call_turn(otel_exporter):
    class ScriptedLLM:
        name = "fake"

        def __init__(self):
            self._i = 0

        async def chat(self, *, system, messages, tools):
            self._i += 1
            if self._i == 1:
                return LLMTurn(tool_calls=[ToolCall(id="1", name="search", input={})], stop=False)
            return LLMTurn(text="done", tool_calls=[], stop=True)

    class EchoTool:
        name = "search"
        description = ""
        input_schema: dict = {}

        async def invoke(self, input):
            return "ok"

    tracer = create_otel_step_tracer()
    agent = Agent(llm=ScriptedLLM(), tools=[EchoTool()], name="my-agent", trace=tracer)

    result = await agent.run("do it", run_id="run-42")

    assert result.text == "done"
    spans = otel_exporter.get_finished_spans()
    # Two llm-turn spans (one per model call) + one tool-call span.
    kinds = sorted(span.attributes["gen_ai.operation.name"] for span in spans)
    assert kinds == ["chat", "chat", "execute_tool"]
    assert all(span.attributes["berth.run_id"] == "run-42" for span in spans)


@pytest.mark.asyncio
async def test_agent_run_emits_no_trace_events_without_a_run_id(otel_exporter):
    llm = _text_only_llm("hi")
    tracer = create_otel_step_tracer()
    agent = Agent(llm=llm, tools=[], trace=tracer)

    await agent.run("hi")  # no run_id given

    assert len(otel_exporter.get_finished_spans()) == 0


def _text_only_llm(text: str):
    class _LLM:
        name = "fake"

        async def chat(self, *, system, messages, tools):
            return LLMTurn(text=text, tool_calls=[], stop=True)

    return _LLM()
