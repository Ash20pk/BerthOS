import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpClientTools } from "./mcp-client.js";

/**
 * A real (if in-process) MCP server, not a mock of the protocol — the SDK's
 * own InMemoryTransport.createLinkedPair() runs the exact same JSON-RPC
 * message flow a stdio/HTTP transport would, just without a subprocess or a
 * socket. This is the same "real protocol, fake transport" posture
 * fleet-computer.test.ts already uses (a real http.Server standing in for a
 * remote instance) — proves createMcpClientTools()'s listTools()/callTool()
 * wiring against real MCP SDK server-side behavior, not a hand-rolled stub.
 */
function startFakeMcpServer() {
  const server = new McpServer({ name: "fake-mcp-server", version: "1.0.0" });

  server.registerTool(
    "greet",
    { description: "Greets someone by name", inputSchema: { name: z.string() } },
    async ({ name }) => ({ content: [{ type: "text", text: `hello ${name}` }] }),
  );

  server.registerTool(
    "get_status",
    { description: "Returns a structured status object", inputSchema: {} },
    async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
      structuredContent: { ok: true, code: 200 },
    }),
  );

  server.registerTool(
    "always_fails",
    { description: "Always reports a tool-level error", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "something went wrong" }], isError: true }),
  );

  return server;
}

test("createMcpClientTools() lists a real server's tools with their JSON Schema", async () => {
  const server = startFakeMcpServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const handle = await createMcpClientTools({ transport: clientTransport });
  try {
    const names = handle.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["always_fails", "get_status", "greet"]);

    const greet = handle.tools.find((t) => t.name === "greet")!;
    assert.equal(greet.description, "Greets someone by name");
    assert.deepEqual((greet.inputSchema as { properties: { name: unknown } }).properties.name, { type: "string" });
  } finally {
    await handle.close();
  }
});

test("createMcpClientTools() dispatches a real tool call and returns its text content", async () => {
  const server = startFakeMcpServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const handle = await createMcpClientTools({ transport: clientTransport });
  try {
    const greet = handle.tools.find((t) => t.name === "greet")!;
    const result = await greet.invoke({ name: "world" });
    assert.equal(result, "hello world");
  } finally {
    await handle.close();
  }
});

test("createMcpClientTools() prefers structuredContent over the text content when a server provides both", async () => {
  const server = startFakeMcpServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const handle = await createMcpClientTools({ transport: clientTransport });
  try {
    const status = handle.tools.find((t) => t.name === "get_status")!;
    const result = await status.invoke({});
    assert.deepEqual(result, { ok: true, code: 200 });
  } finally {
    await handle.close();
  }
});

test("createMcpClientTools() throws (not returns) when the server reports isError, so Agent.run()'s existing tool-error handling catches it", async () => {
  const server = startFakeMcpServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const handle = await createMcpClientTools({ transport: clientTransport });
  try {
    const failing = handle.tools.find((t) => t.name === "always_fails")!;
    await assert.rejects(() => failing.invoke({}), /something went wrong/);
  } finally {
    await handle.close();
  }
});
