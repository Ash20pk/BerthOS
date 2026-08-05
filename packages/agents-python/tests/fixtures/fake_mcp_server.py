#!/usr/bin/env python3
"""A real (if minimal) MCP server, spawned as a real subprocess by
test_mcp_client.py — not a mock of the protocol. Mirrors
packages/agents/src/mcp-client.test.ts's TypeScript fixture server."""

import asyncio

from mcp.server import MCPServer

server = MCPServer("fake-mcp-server", version="1.0.0")


@server.tool(structured_output=False)
async def greet(name: str) -> str:
    """Greets someone by name"""
    return f"hello {name}"


@server.tool(structured_output=True)
async def get_status() -> dict[str, object]:
    """Returns a structured status object"""
    return {"ok": True, "code": 200}


@server.tool()
async def always_fails() -> str:
    """Always reports a tool-level error"""
    raise RuntimeError("something went wrong")


if __name__ == "__main__":
    asyncio.run(server.run_stdio_async())
