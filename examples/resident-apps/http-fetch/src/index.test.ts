import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "./index.js";

test("fetch_text fetches a real URL and returns its body text", async () => {
  const server = http.createServer((_req, res) => res.writeHead(200).end("hello from a real local server"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  try {
    const def = app._exports.get("fetch_text")!;
    const result = await def.handler({ url: `http://127.0.0.1:${port}/` });
    assert.deepEqual(result, { text: "hello from a real local server" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
