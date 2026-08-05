import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

/**
 * index.ts reads JSONPLACEHOLDER_BASE_URL at module-load time (see its own
 * comment), so it has to be set *before* the module is imported — a static
 * top-level `import` would already have run the module body first. A
 * dynamic import() inside each test, after the local server is listening
 * and the env var is set, is what makes that ordering work.
 */
async function importAppPointedAt(baseUrl: string) {
  process.env.JSONPLACEHOLDER_BASE_URL = baseUrl;
  const mod = (await import(`./index.js?t=${Date.now()}-${Math.random()}`)) as { default: typeof import("./index.js").default };
  return mod.default;
}

test("get_post makes a real GET request to the configured base URL with the id filled into the path", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/posts/1") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: 1, title: "a post" }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  try {
    const app = await importAppPointedAt(`http://127.0.0.1:${port}`);
    const def = app._exports.get("get_post")!;

    const result = await def.handler(def.input!.parse({ id: 1 }));

    assert.deepEqual(result, { status: 200, data: { id: 1, title: "a post" } });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("create_post sends a real POST request with the body params as JSON", async () => {
  let received: { method?: string; body?: string } = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received = { method: req.method, body };
      res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ id: 101 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  try {
    const app = await importAppPointedAt(`http://127.0.0.1:${port}`);
    const def = app._exports.get("create_post")!;

    const result = await def.handler(def.input!.parse({ title: "hello", body: "world", userId: 7 }));

    assert.equal(received.method, "POST");
    assert.deepEqual(JSON.parse(received.body ?? "{}"), { title: "hello", body: "world", userId: 7 });
    assert.deepEqual(result, { status: 201, data: { id: 101 } });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
