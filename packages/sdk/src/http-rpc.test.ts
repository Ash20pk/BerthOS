import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineApp } from "./app.js";
import { startHttpRpcServer } from "./http-rpc.js";

function testApp() {
  return defineApp((a) => {
    a.export({
      name: "greet",
      input: z.object({ name: z.string() }),
      output: z.string(),
      handler: ({ name }) => `hello ${name}`,
    });
  });
}

async function withServer<T>(authToken: string, fn: (port: number) => Promise<T>): Promise<T> {
  const port = 20000 + Math.floor(Math.random() * 10000);
  const server = startHttpRpcServer(testApp(), { port, authToken });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50)); // let listen() bind before dialing
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET /healthz returns 200 with no auth required", async () => {
  await withServer("secret-token", async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test("POST /rpc with the correct bearer token dispatches to the export", async () => {
  await withServer("secret-token", async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify({ id: "1", export: "greet", input: { name: "world" } }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: "1", result: "hello world" });
  });
});

test("POST /rpc with a wrong bearer token is rejected", async () => {
  await withServer("secret-token", async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ id: "1", export: "greet", input: { name: "world" } }),
    });
    assert.equal(res.status, 401);
  });
});

test("POST /rpc with no Authorization header is rejected", async () => {
  await withServer("secret-token", async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "1", export: "greet", input: { name: "world" } }),
    });
    assert.equal(res.status, 401);
  });
});

test("unknown routes get a 404", async () => {
  await withServer("secret-token", async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
  });
});
