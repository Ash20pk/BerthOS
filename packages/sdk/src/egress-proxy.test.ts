import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { generateSelfSignedCerts } from "@berthos/tls";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { configureEgressProxy } from "./egress-proxy.js";

const execFileAsync = promisify(execFile);

// configureEgressProxy() swaps these globals for undici's; each test that
// calls it puts them back, so no later test runs against a replaced fetch().
const nativeGlobals = {
  fetch: globalThis.fetch,
  Headers: globalThis.Headers,
  Request: globalThis.Request,
  Response: globalThis.Response,
  FormData: globalThis.FormData,
};
function restoreGlobals(dispatcher: ReturnType<typeof getGlobalDispatcher>): void {
  delete process.env.BERTH_EGRESS_PROXY_URL;
  setGlobalDispatcher(dispatcher);
  Object.assign(globalThis, nativeGlobals);
}

test("configureEgressProxy() is a no-op when BERTH_EGRESS_PROXY_URL is unset", () => {
  delete process.env.BERTH_EGRESS_PROXY_URL;
  const before = getGlobalDispatcher();
  configureEgressProxy();
  assert.equal(getGlobalDispatcher(), before, "should not touch the global dispatcher when the env var is absent");
});

// Real, not mocked: a genuine local HTTP server stands in for the egress
// broker, and a real fetch() call is made through undici's actual
// ProxyAgent — this is what proves the SDK's own half of the pipeline
// (env var -> global dispatcher) works, independent of egress-broker.cjs's
// own host-matching logic (covered separately in
// packages/docker-orchestrator/test/egress-broker-milestone.mjs).
test("configureEgressProxy() routes global fetch() through the configured proxy", async () => {
  const receivedRequests: string[] = [];
  const fakeProxy = http.createServer((req, res) => {
    receivedRequests.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain" }).end("hello from behind the proxy");
  });
  await new Promise<void>((resolve) => fakeProxy.listen(0, "127.0.0.1", resolve));
  const { port } = fakeProxy.address() as { port: number };

  const originalDispatcher = getGlobalDispatcher();
  process.env.BERTH_EGRESS_PROXY_URL = `http://127.0.0.1:${port}`;
  configureEgressProxy();

  try {
    // A hostname that doesn't need to resolve on this machine at all — a
    // plain-HTTP forward-proxy request sends the absolute URI to the proxy
    // and lets *it* resolve/connect, exactly like egress-broker.cjs's own
    // plain-HTTP handler does; if this test's fetch() somehow tried to
    // resolve "target.invalid" itself instead of routing through the fake
    // proxy, it would fail outright rather than reach the fake proxy at all.
    const res = await fetch("http://target.invalid/some/path?x=1");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "hello from behind the proxy");
    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0], "http://target.invalid/some/path?x=1");
  } finally {
    restoreGlobals(originalDispatcher);
    await new Promise<void>((resolve) => fakeProxy.close(() => resolve()));
  }
});

// A Request built from Node's built-in class before the swap (or by a library
// that kept a reference to it) is not one undici's fetch() recognises; it used
// to fail with "Failed to parse URL from [object Request]".
test("configureEgressProxy() still accepts a Request built from the built-in class", async () => {
  const received: { url: string; method: string; header: string | undefined; body: string }[] = [];
  const fakeProxy = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      received.push({ url: req.url ?? "", method: req.method ?? "", header: req.headers["x-berth-test"] as string | undefined, body });
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
  });
  await new Promise<void>((resolve) => fakeProxy.listen(0, "127.0.0.1", resolve));
  const { port } = fakeProxy.address() as { port: number };

  const originalDispatcher = getGlobalDispatcher();
  const early = new nativeGlobals.Request("http://target.invalid/early", {
    method: "POST",
    headers: { "x-berth-test": "kept" },
    body: "payload",
  });
  process.env.BERTH_EGRESS_PROXY_URL = `http://127.0.0.1:${port}`;
  configureEgressProxy();

  try {
    assert.notEqual(globalThis.Request, nativeGlobals.Request, "the swap should have happened");
    const res = await fetch(early);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.deepEqual(received, [{ url: "http://target.invalid/early", method: "POST", header: "kept", body: "payload" }]);

    const bodiless = await fetch(new nativeGlobals.Request("http://target.invalid/get"));
    assert.equal(bodiless.status, 200);
    await bodiless.text();
    assert.equal(received[1]?.method, "GET");
  } finally {
    restoreGlobals(originalDispatcher);
    await new Promise<void>((resolve) => fakeProxy.close(() => resolve()));
  }
});

// A built-in Request with a string body has to reach the server as the
// built-in fetch() would send it: with content-length rather than chunked, and
// resent when a 307 asks for the same body again. The same server plays the
// origin for a direct native fetch() and the proxy for a proxied one (a
// plain-HTTP forward proxy is handed the absolute URI), so each outcome is
// checked against what native fetch() does with the same Request.
test("configureEgressProxy() sends a built-in Request's body the way native fetch() does", async () => {
  const seen: { path: string; length: string | undefined; chunked: boolean; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://placeholder").pathname;
      seen.push({ path, length: req.headers["content-length"], chunked: req.headers["transfer-encoding"] === "chunked", body });
      if (req.headers["content-length"] === undefined) {
        res.writeHead(411).end();
      } else if (path === "/moved") {
        res.writeHead(307, { location: "/landed" }).end();
      } else {
        res.writeHead(200, { "content-type": "text/plain" }).end(`got ${body}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  const makeRequests = () => ({
    plain: new nativeGlobals.Request(`${base}/plain`, { method: "POST", body: "payload" }),
    redirected: new nativeGlobals.Request(`${base}/moved`, { method: "POST", body: "payload" }),
  });

  const outcome = async (res: Promise<Response | globalThis.Response>) => {
    const r = await res;
    return { status: r.status, text: await r.text() };
  };

  const originalDispatcher = getGlobalDispatcher();
  try {
    const native = makeRequests();
    const nativePlain = await outcome(nativeGlobals.fetch(native.plain));
    const nativeRedirected = await outcome(nativeGlobals.fetch(native.redirected));
    const nativeSeen = seen.splice(0);
    assert.deepEqual(nativePlain, { status: 200, text: "got payload" });
    assert.deepEqual(nativeRedirected, { status: 200, text: "got payload" });

    const early = makeRequests();
    process.env.BERTH_EGRESS_PROXY_URL = base;
    configureEgressProxy();
    assert.deepEqual(await outcome(fetch(early.plain)), nativePlain);
    assert.deepEqual(await outcome(fetch(early.redirected)), nativeRedirected);
    assert.deepEqual(seen, nativeSeen);
    assert.deepEqual(
      seen.map((s) => s.path),
      ["/plain", "/moved", "/landed"],
    );
    assert.ok(seen.every((s) => s.length === "7" && !s.chunked && s.body === "payload"));
  } finally {
    restoreGlobals(originalDispatcher);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// fetch() reports every failure, a Request whose body was already read
// included, as a rejected promise; code that attaches .catch() relies on it.
test("configureEgressProxy() rejects, rather than throws, for a built-in Request whose body was used", async () => {
  const used = new nativeGlobals.Request("http://target.invalid/used", { method: "POST", body: "payload" });
  await used.text();
  const nativeResult = nativeGlobals.fetch(used);
  assert.ok(nativeResult instanceof Promise);
  await assert.rejects(nativeResult, TypeError);

  const originalDispatcher = getGlobalDispatcher();
  process.env.BERTH_EGRESS_PROXY_URL = "http://127.0.0.1:9";
  configureEgressProxy();
  try {
    let result: unknown;
    assert.doesNotThrow(() => {
      result = fetch(used);
    });
    assert.ok(result instanceof Promise);
    await assert.rejects(result as Promise<unknown>, TypeError);
  } finally {
    restoreGlobals(originalDispatcher);
  }
});

// What egress-broker.cjs actually does for HTTPS: a CONNECT tunnel to the
// origin, which speaks HTTP/2 and answers compressed, as nearly every real
// site does. Before the fix, configureEgressProxy() drove Node's built-in
// fetch() (a bundled, older undici) with this package's ProxyAgent; across
// that version gap the headers of an HTTP/2 response were lost, so fetch()
// never saw content-encoding, never decompressed, and apps got raw brotli/gzip
// bytes. HTTP/1.1 responses were unaffected, which is why the test above never
// caught it.
for (const [encoding, compress] of [
  ["gzip", gzipSync],
  ["br", brotliCompressSync],
] as const) {
  test(`configureEgressProxy() decodes ${encoding} responses through an HTTPS tunnel`, async () => {
    const body = "<html>decoded through the tunnel</html>";
    const dir = mkdtempSync(join(tmpdir(), "berth-egress-proxy-tls-"));
    const { caCertPath, certPath, keyPath } = generateSelfSignedCerts({ dir, hosts: ["localhost", "127.0.0.1"] });
    // HTTP/2 with HTTP/1.1 fallback, as real origins offer: the header loss
    // only happened when the tunnelled connection negotiated h2.
    const origin = http2.createSecureServer({ cert: readFileSync(certPath), key: readFileSync(keyPath), allowHTTP1: true }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": encoding }).end(compress(Buffer.from(body)));
    });
    const proxy = http.createServer();
    proxy.on("connect", (req, socket, head) => {
      const [host, port] = (req.url ?? "").split(":");
      const upstream = net.connect(Number(port), host, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(socket).pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));

    // In a child process, so the origin's self-signed CA can be trusted the
    // way a real deployment would add one (NODE_EXTRA_CA_CERTS, read at
    // startup), without turning certificate checks off.
    const child = `
      const { configureEgressProxy } = await import(${JSON.stringify(new URL("./egress-proxy.js", import.meta.url).href)});
      configureEgressProxy();
      const res = await fetch("https://localhost:${(origin.address() as { port: number }).port}/");
      console.log(JSON.stringify({ encoding: res.headers.get("content-encoding"), body: await res.text() }));
    `;
    try {
      const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", child], {
        env: {
          ...process.env,
          BERTH_EGRESS_PROXY_URL: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
          NODE_EXTRA_CA_CERTS: caCertPath,
        },
      });
      const res = JSON.parse(stdout) as { encoding: string | null; body: string };
      assert.equal(res.encoding, encoding);
      assert.equal(res.body, body);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await new Promise<void>((resolve) => origin.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
