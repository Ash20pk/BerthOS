import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAllowed, parseHostScope, resetAllowedPatterns } from "./hosts.js";
import { pageFromHtml } from "./page.js";

// A manifest that allows 127.0.0.1 on any port and nothing else. Refusals
// use example.org, which is refused before any connection is attempted.
const dir = await mkdtemp(join(tmpdir(), "web-fetch-test-"));
await writeFile(
  join(dir, "berth.yml"),
  "name: web-fetch\nversion: 0.1.0\ncapabilities:\n  - network:host:127.0.0.1:*\n  - network:connect:8090\nexports: []\n",
);
process.env.BERTH_MANIFEST_PATH = join(dir, "berth.yml");
// These talk to a local server directly. `berth test` runs them inside the
// sandbox, where the egress proxy's address is set and would refuse loopback.
delete process.env.BERTH_EGRESS_PROXY_URL;
resetAllowedPatterns();
const { default: app } = await import("./index.js");
const call = (name: string, input: unknown = {}) => app._exports.get(name)!.handler(input) as Promise<any>;

// `berth test` runs this file inside the sandbox, under web-fetch's own
// capabilities, which don't include listening on a port: the local server
// below gets EACCES there. Those tests run everywhere else (pnpm test, CI);
// the pure ones run in both.
const inSandbox = process.env.BERTH_TEST_MODE === "1";
const serverTest = (name: string, fn: () => Promise<void>) => test(name, { skip: inSandbox && "needs a local server, which the sandbox won't let this app listen for" }, fn);

let hits: { url: string; method: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let base = "";
let port = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hits.push({ url: req.url ?? "", method: req.method ?? "", headers: req.headers, body });
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        `<html><head><title>Q4 &amp; plans</title><script>var secret = 1;</script></head><body><h1>Roadmap</h1><p>Ship <b>attestation</b>&nbsp;first.</p><a href="/next">Next page</a><a href="https://example.com/x">Out</a></body></html>`,
      );
    } else if (req.url === "/echo") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ method: req.method, type: req.headers["content-type"], body }));
    } else if (req.url === "/to-undeclared") {
      res.writeHead(302, { location: "https://example.org/page" }).end();
    } else if (req.url === "/to-page") {
      res.writeHead(301, { location: "/page" }).end();
    } else if (req.url === "/heavy-head") {
      // Like most real pages: more script in <head> than the text cap.
      res.writeHead(200, { "content-type": "text/html" }).end(
        `<html><head><title>Heavy</title><script>${"var x = 1;".repeat(20_000)}</script></head><body><p>The article.</p>${"<p>more</p>".repeat(20_000)}</body></html>`,
      );
    } else if (req.url === "/forbidden") {
      res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden: 403");
    } else if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" }).end("x".repeat(150_000));
    } else if (req.url === "/image") {
      res.writeHead(200, { "content-type": "image/png" }).end(Buffer.alloc(64));
    } else {
      res.writeHead(404, { "content-type": "text/plain" }).end("nope");
    }
  });
});

before(async () => {
  if (inSandbox) return;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
});
after(() => {
  if (!inSandbox) server.close();
});

serverTest("get returns the status, content type and body", async () => {
  const res = await call("get", { url: `${base}/echo` });
  assert.equal(res.status, 200);
  assert.match(res.content_type, /json/);
  assert.equal(JSON.parse(res.body).method, "GET");
  assert.equal(res.truncated, false);
});

serverTest("request sends the method, body and content type", async () => {
  const res = await call("request", { method: "post", url: `${base}/echo`, body: '{"a":1}', content_type: "application/json" });
  assert.deepEqual(JSON.parse(res.body), { method: "POST", type: "application/json", body: '{"a":1}' });
});

serverTest("read_page returns readable text, the title and absolute links, and drops scripts", async () => {
  const page = await call("read_page", { url: `${base}/page` });
  assert.equal(page.title, "Q4 & plans");
  assert.equal(page.text, "Roadmap\nShip attestation first.\nNext page Out");
  assert.ok(!page.text.includes("secret"));
  assert.deepEqual(page.links, [
    { text: "Next page", href: `${base}/next` },
    { text: "Out", href: "https://example.com/x" },
  ]);
});

serverTest("read_page reads a page whose <head> alone is longer than the text cap", async () => {
  const page = await call("read_page", { url: `${base}/heavy-head` });
  assert.equal(page.title, "Heavy");
  assert.ok(page.text.startsWith("The article.\nmore"), page.text.slice(0, 80));
  assert.equal(page.text.length, 100_000);
  assert.equal(page.truncated, true);
});

serverTest("a host berth.yml doesn't name is refused before anything is sent, naming the line to add", async () => {
  hits = [];
  await assert.rejects(call("get", { url: "https://example.org/echo" }), (err: Error) => {
    assert.match(err.message, /example\.org isn't one of the hosts web-fetch may reach \(127\.0\.0\.1:\*\)/);
    assert.match(err.message, /`- network:host:example\.org`/);
    return true;
  });
  assert.equal(hits.length, 0);
});

serverTest("a redirect to an undeclared host is refused; one to a declared host is followed", async () => {
  hits = [];
  await assert.rejects(call("get", { url: `${base}/to-undeclared` }), /example\.org isn't one of the hosts/);
  assert.deepEqual(hits.map((h) => h.url), ["/to-undeclared"]);
  const followed = await call("read_page", { url: `${base}/to-page` });
  assert.equal(followed.url, `${base}/page`);
  assert.equal(followed.title, "Q4 & plans");
});

serverTest("large and binary bodies are capped, not dropped or dumped", async () => {
  const big = await call("get", { url: `${base}/big` });
  assert.equal(big.body.length, 100_000);
  assert.equal(big.truncated, true);
  const image = await call("get", { url: `${base}/image` });
  assert.equal(image.body, "[image/png body, 64 bytes, not shown]");
});

serverTest("WEB_FETCH_HEADERS adds headers for its host only", async () => {
  process.env.WEB_FETCH_HEADERS = JSON.stringify({ "127.0.0.1": { authorization: "Bearer from-secret" }, "api.other.example": { authorization: "Bearer other" } });
  try {
    hits = [];
    await call("get", { url: `${base}/echo` });
    assert.equal(hits[0]!.headers.authorization, "Bearer from-secret");
  } finally {
    delete process.env.WEB_FETCH_HEADERS;
  }
  hits = [];
  await call("get", { url: `${base}/echo` });
  assert.equal(hits[0]!.headers.authorization, undefined);
});

test("WEB_FETCH_HEADERS are only sent over https, so a redirect down to http drops them", async () => {
  const { secretHeadersFor } = await import("./index.js");
  process.env.WEB_FETCH_HEADERS = JSON.stringify({ "api.example.com": { authorization: "Bearer from-secret" }, "127.0.0.1": { authorization: "Bearer local" } });
  try {
    assert.deepEqual(secretHeadersFor(new URL("https://api.example.com/v1")), { authorization: "Bearer from-secret" });
    // What an https URL redirected to http on the same host asks for next.
    assert.deepEqual(secretHeadersFor(new URL("http://api.example.com/v1")), {});
    // Loopback never leaves the machine.
    assert.deepEqual(secretHeadersFor(new URL("http://127.0.0.1:8080/")), { authorization: "Bearer local" });
  } finally {
    delete process.env.WEB_FETCH_HEADERS;
  }
});

serverTest("the egress proxy's refusals are explained, for https and for plain http", async () => {
  // A stand-in for the sandbox's egress proxy that refuses everything, the
  // way it refuses a declared name that resolves to an internal address.
  const proxy = http.createServer((_req, res) => {
    res.writeHead(403, { "content-type": "text/plain" }).end('egress denied: "127.0.0.1" resolves to 127.0.0.1, which is loopback, private, link-local, or otherwise internal');
  });
  proxy.on("connect", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  process.env.BERTH_EGRESS_PROXY_URL = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  try {
    await assert.rejects(call("get", { url: `https://127.0.0.1:${port}/echo` }), /egress proxy refused 127\.0\.0\.1, although berth\.yml allows it.*Proxy response \(403\)/);
    await assert.rejects(call("get", { url: `${base}/echo` }), /egress proxy refused 127\.0\.0\.1, although berth\.yml allows it.*egress denied: .*internal/);
  } finally {
    delete process.env.BERTH_EGRESS_PROXY_URL;
    proxy.close();
  }
});

serverTest("a 403 from the site itself is returned as a response, not reported as the proxy's refusal", async () => {
  const res = await call("get", { url: `${base}/forbidden` });
  assert.equal(res.status, 403);
  assert.equal(res.body, "Forbidden: 403");
});

serverTest("non-http URLs and unsupported methods are refused", async () => {
  await assert.rejects(call("get", { url: "file:///etc/passwd" }), /only http and https/);
  await assert.rejects(call("get", { url: "not a url" }), /isn't an absolute URL/);
  await assert.rejects(call("request", { method: "TRACE", url: `${base}/echo`, body: "", content_type: "" }), /unsupported method/);
});

test("an internal address is explained as never reachable, not as a missing declaration", async () => {
  await assert.rejects(call("get", { url: "http://169.254.169.254/latest/meta-data/" }), /internal address .* never lets an app reach one/);
  await assert.rejects(call("get", { url: "http://10.0.0.5/" }), /internal address/);
});

test("IPv6 literals are told apart: internal ones as internal, public ones as unreachable over IPv4", async () => {
  for (const host of ["[::1]", "[::]", "[fe80::1]", "[fd00::1]", "[fc12:3456::1]", "[ff02::1]", "[::ffff:10.0.0.1]", "[::ffff:169.254.169.254]", "[64:ff9b::7f00:1]"]) {
    await assert.rejects(call("get", { url: `http://${host}/` }), /is an internal address/, host);
  }
  for (const host of ["[2606:4700::1111]", "[::ffff:8.8.8.8]"]) {
    await assert.rejects(call("get", { url: `http://${host}/` }), /is an IPv6 address, and the sandbox's egress proxy connects over IPv4 only/, host);
  }
});

test("allowed_hosts lists the declared patterns", async () => {
  assert.deepEqual(await call("allowed_hosts"), { hosts: ["127.0.0.1:*"] });
});

test("host patterns match the egress proxy's rules", () => {
  const p = ["example.com", "*.example.org", "db.internal:5432", "any.example:*"].map(parseHostScope);
  assert.equal(isAllowed(p, "example.com", 443), true);
  assert.equal(isAllowed(p, "example.com", 8080), false, "no port means 80 and 443 only");
  assert.equal(isAllowed(p, "api.example.org", 443), true);
  assert.equal(isAllowed(p, "example.org", 443), false, "*.example.org doesn't cover the apex");
  assert.equal(isAllowed(p, "db.internal", 5432), true);
  assert.equal(isAllowed(p, "db.internal", 443), false);
  assert.equal(isAllowed(p, "any.example", 9999), true);
  assert.equal(isAllowed(p, "evil-example.com", 443), false);
});

test("page text decodes entities and keeps block structure", () => {
  const page = pageFromHtml("<ul><li>a &lt;b&gt;</li><li>c&#39;d &#x263A;</li></ul>", "https://x.test/");
  assert.equal(page.text, "a <b>\nc'd ☺");
});

test("nested and unclosed markup can't leave a script behind, and only http(s) links are kept", () => {
  const page = pageFromHtml(
    `<a href="javascript:alert(1)">a</a><a href="data:text/html,x">b</a><a href="vbscript:x">c</a><a href="mailto:x@y.z">d</a><a href="/ok">ok</a>` +
      `<p>before</p><scr<script>x()</script>ipt>alert(1)</script><p>after</p><!-- <script>y()</script> --><p>end <script>unclosed`,
    "https://x.test/",
  );
  // No markup survives, and nothing inside a real script element does
  // (y() sits in a comment, "unclosed" after an unclosed <script>). The
  // "<scr<script>" junk is an unknown element to a browser too, so what
  // follows it is plain text, as it is here.
  assert.ok(!/<[a-z!\/]/i.test(page.text), page.text);
  assert.ok(!/y\(\)|unclosed/.test(page.text), page.text);
  assert.ok(page.text.includes("before") && page.text.includes("after") && page.text.includes("end"));
  assert.deepEqual(page.links, [{ text: "ok", href: "https://x.test/ok" }]);
});
