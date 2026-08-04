import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { configureEgressProxy } from "./egress-proxy.js";

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
    delete process.env.BERTH_EGRESS_PROXY_URL;
    setGlobalDispatcher(originalDispatcher);
    await new Promise<void>((resolve) => fakeProxy.close(() => resolve()));
  }
});
