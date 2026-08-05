"""The other half of `berth mcp` (which makes a Berth resident app's exports
available to any MCP client — Claude Desktop, Claude Code, ...): this lets a
Python `Agent` be the *client*, consuming any external MCP server's tools as
ordinary Tools. Mirrors @berth/agents' mcp-client.ts field-for-field —
snake_case instead of camelCase, `contextlib.AsyncExitStack` standing in for
TypeScript's plain `client.close()` since Python's `ClientSession`/transport
pair are async context managers that must stay entered for the connection's
whole lifetime, not a single object with a `close()` method."""

from __future__ import annotations

from contextlib import AsyncExitStack
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client


class McpClientHandle:
    """`tools`: a list of Tool-shaped objects (name/description/input_schema/
    invoke), ready to hand to an Agent alongside any other Tool. `close()`
    tears down the underlying transport (a child process for stdio, an
    HTTP/SSE session for streamable HTTP) — nothing else can clean this up on
    your behalf, since it outlives any single tool call."""

    def __init__(self, tools: list[Any], exit_stack: AsyncExitStack) -> None:
        self.tools = tools
        self._exit_stack = exit_stack

    async def close(self) -> None:
        await self._exit_stack.aclose()


def _input_schema_or_default(mcp_tool: Any) -> dict[str, Any]:
    return mcp_tool.input_schema or {"type": "object", "properties": {}}


def _extract_result(result: Any) -> Any:
    """MCP tool results carry a `content` block array (text/image/audio/
    resource) plus an optional `structured_content` — prefer the latter when
    a server provides it, otherwise collapse an all-text content array into
    a plain string (the common case), otherwise fall back to the raw content
    list so non-text results aren't silently dropped."""
    if result.structured_content is not None:
        return result.structured_content
    content = result.content or []
    if content and all(getattr(block, "type", None) == "text" for block in content):
        return "\n".join(block.text for block in content)
    return content


def _extract_error_text(result: Any, tool_name: str) -> str:
    content = result.content or []
    text = "\n".join(block.text for block in content if getattr(block, "type", None) == "text" and getattr(block, "text", None))
    return text or f'MCP tool "{tool_name}" reported an error'


class _McpTool:
    def __init__(self, session: ClientSession, name: str, description: str, input_schema: dict[str, Any]) -> None:
        self.name = name
        self.description = description
        self.input_schema = input_schema
        self._session = session

    async def invoke(self, input: Any) -> Any:
        result = await self._session.call_tool(self.name, arguments=input or {})
        if getattr(result, "is_error", False):
            raise RuntimeError(_extract_error_text(result, self.name))
        return _extract_result(result)


async def create_mcp_client_tools(
    *,
    command: str | None = None,
    args: list[str] | None = None,
    env: dict[str, str] | None = None,
    url: str | None = None,
    headers: dict[str, str] | None = None,
    name: str = "berth-agent",
    version: str = "0.0.0",
) -> McpClientHandle:
    """Connects to an external MCP server and returns its tools as ordinary
    Tools — mix them into an Agent's `tools` list alongside resident-app
    exports (once `Computer.connect()` exists for a given app) and other
    agents freely, since they all share the same duck-typed Tool shape. No
    schema translation needed: MCP's `tools/list` already returns JSON
    Schema, exactly what `Tool.input_schema` expects.

    Pass either `command=`/`args=`/`env=` (spawns a local server over stdio)
    or `url=`/`headers=` (a remote server over Streamable HTTP), not both.
    """
    if command and url:
        raise ValueError("create_mcp_client_tools() takes either command= (stdio) or url= (streamable HTTP), not both")

    exit_stack = AsyncExitStack()
    try:
        if command:
            params = StdioServerParameters(command=command, args=args or [], env=env)
            read, write = await exit_stack.enter_async_context(stdio_client(params))
        elif url:
            http_client = None
            if headers:
                import httpx

                http_client = httpx.AsyncClient(headers=headers)
            read, write = await exit_stack.enter_async_context(streamable_http_client(url, http_client=http_client))
        else:
            raise ValueError("create_mcp_client_tools() needs command= (stdio) or url= (streamable HTTP)")

        session = await exit_stack.enter_async_context(ClientSession(read, write))
        await session.initialize()

        listed = await session.list_tools()
        tools: list[Any] = [
            _McpTool(session, tool.name, tool.description or "", _input_schema_or_default(tool)) for tool in listed.tools
        ]
        return McpClientHandle(tools, exit_stack)
    except Exception:
        await exit_stack.aclose()
        raise
