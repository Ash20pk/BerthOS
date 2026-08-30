import sys
from pathlib import Path

import pytest

from berth_agents.mcp_client import create_mcp_client_tools

FIXTURE_SERVER = str(Path(__file__).parent / "fixtures" / "fake_mcp_server.py")


@pytest.mark.asyncio
async def test_lists_a_real_servers_tools_with_their_json_schema():
    handle = await create_mcp_client_tools(command=sys.executable, args=[FIXTURE_SERVER])
    try:
        names = sorted(t.name for t in handle.tools)
        assert names == ["always_fails", "get_status", "greet"]

        greet = next(t for t in handle.tools if t.name == "greet")
        assert greet.description == "Greets someone by name"
        assert greet.input_schema["properties"]["name"]["type"] == "string"
    finally:
        await handle.close()


@pytest.mark.asyncio
async def test_dispatches_a_real_tool_call_and_returns_its_text_content():
    handle = await create_mcp_client_tools(command=sys.executable, args=[FIXTURE_SERVER])
    try:
        greet = next(t for t in handle.tools if t.name == "greet")
        result = await greet.invoke({"name": "world"})
        assert result == "hello world"
    finally:
        await handle.close()


@pytest.mark.asyncio
async def test_prefers_structured_content_when_a_server_provides_it():
    handle = await create_mcp_client_tools(command=sys.executable, args=[FIXTURE_SERVER])
    try:
        status = next(t for t in handle.tools if t.name == "get_status")
        result = await status.invoke({})
        assert result == {"ok": True, "code": 200}
    finally:
        await handle.close()


@pytest.mark.asyncio
async def test_raises_instead_of_returning_when_the_server_reports_an_error():
    handle = await create_mcp_client_tools(command=sys.executable, args=[FIXTURE_SERVER])
    try:
        failing = next(t for t in handle.tools if t.name == "always_fails")
        with pytest.raises(RuntimeError, match="something went wrong"):
            await failing.invoke({})
    finally:
        await handle.close()


@pytest.mark.asyncio
async def test_rejects_both_command_and_url_given_together():
    with pytest.raises(ValueError, match="not both"):
        await create_mcp_client_tools(command=sys.executable, url="http://example.com")


@pytest.mark.asyncio
async def test_requires_either_command_or_url():
    with pytest.raises(ValueError, match="needs command="):
        await create_mcp_client_tools()
