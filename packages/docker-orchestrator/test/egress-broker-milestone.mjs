#!/usr/bin/env node
// Real, running verification of the egress broker
// (packages/docker-orchestrator/docker/egress-broker.js), which enforces
// browser:navigate:<pattern> AND network:host:<pattern> at the host level —
// the same mechanism under two capability names, so any resident app (not
// just one that also drives a browser) can declare host-scoped egress.
//
// Parts:
//   Part A runs the actual shipped broker script directly (no Docker) with
//   a hand-written capability policy declaring a NARROW browser:navigate:
//   pattern, and proves both outcomes for real: an in-scope host's CONNECT
//   tunnel succeeds (200), an out-of-scope host's is refused (403).
//   browser-native's own real manifest declares browser:navigate:* (any
//   host, since it's meant to navigate wherever the agent points it) — the
//   wildcard match would make a denial untestable against the real app, so
//   this part is what actually exercises the broker's host-matching/refusal
//   logic for real.
//
//   Part A1 proves the generalization itself: the exact same broker script,
//   given a policy declaring ONLY network:host:<pattern> — no
//   browser:navigate: at all — enforces host-matching identically. This is
//   what makes the capability real for a plain, non-Chromium app instead of
//   a claim resting on reading the source.
//
//   Part A2 covers BERTH_EGRESS_UPSTREAM_PROXY chaining against a real (if
//   fake) second CONNECT proxy — no Docker needed, same shape as Part A.
//
//   Part B boots the real browser-native sandbox and drives an actual
//   Chromium navigation through the broker, confirming end-to-end wiring:
//   the proxy option really routes traffic through the broker (visible in
//   the broker's own allow-log line), not around it.
//
//   Part C is Part B's counterpart for the generalization itself: boots
//   examples/resident-apps/http-fetch — a plain fetch()-based app with no
//   browser:* capability at all — and confirms it gets the identical
//   broker treatment (started for it, its traffic really flows through it)
//   via nothing more than a network:host:* capability and one
//   configureEgressProxy() call in its own code, no Chromium launch flag.
import Docker from "dockerode";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadManifest } from "@berth/manifest-schema";
import { buildImage, startContainer, stopContainer } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const BROKER_SCRIPT = join(__dirname, "..", "docker", "egress-broker.cjs");
const BROWSER_NATIVE_APP_DIR = join(REPO_ROOT, "apps", "browser-native");
const HTTP_FETCH_APP_DIR = join(REPO_ROOT, "examples", "resident-apps", "http-fetch");

const docker = new Docker();

async function main() {
  await runPartA();
  await runPartA1();
  await runPartA2();
  await runPartB();
  await runPartC();
}

async function runPartA() {
  console.log("\n=== Part A: broker host-matching, run directly (no Docker) ===");
  const dataDir = await mkdtemp(join(tmpdir(), "berth-egress-broker-milestone-"));
  const policyPath = join(dataDir, "capability-policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      appName: "scoped-test-app",
      declaredCapabilities: ["browser:navigate:example.com", "browser:navigate:*.example.org"],
      writePaths: [],
      readPaths: [],
      networkPorts: [],
      networkUnrestricted: false,
    }),
  );

  const port = 58090;
  const broker = spawn(process.execPath, [BROKER_SCRIPT], {
    env: { ...process.env, BERTH_EGRESS_BROKER_PORT: String(port), BERTH_CAPABILITY_POLICY: policyPath },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  broker.stderr.on("data", (chunk) => (stderr += chunk.toString("utf-8")));

  try {
    await waitFor(() => stderr.includes("listening on"), 5000, "broker to start listening");
    console.log(stderr.trim());
    assert(stderr.includes("example.com") && stderr.includes("*.example.org"), "broker didn't log the expected declared patterns");

    console.log("\n--- CONNECT to an in-scope host (example.com) ---");
    const allowed = await connectThroughProxy(port, "example.com", 443);
    console.log(`status: ${allowed.statusCode}`);
    assert(allowed.statusCode === 200, `expected 200 for an in-scope host, got ${allowed.statusCode}`);

    console.log("\n--- CONNECT to an out-of-scope host (evil-not-declared.test) ---");
    const denied = await connectThroughProxy(port, "evil-not-declared.test", 443);
    console.log(`status: ${denied.statusCode}`);
    assert(denied.statusCode === 403, `expected 403 for an out-of-scope host, got ${denied.statusCode}`);

    console.log("\nPASS — the broker allowed an in-scope host and refused an out-of-scope one, for real.");
  } finally {
    broker.kill();
    await rm(dataDir, { recursive: true, force: true });
  }
}

// Part A1: the exact same broker script, given a policy declaring ONLY
// network:host:<pattern> — no browser:navigate: capability anywhere in it —
// still enforces host-matching identically. This is the real proof that
// network:host:* isn't special-cased to browser-native's capability name;
// any resident app declaring it gets the identical broker behavior.
async function runPartA1() {
  console.log("\n=== Part A1: network:host:<pattern> capability (no browser:navigate: at all), run directly (no Docker) ===");
  const dataDir = await mkdtemp(join(tmpdir(), "berth-egress-broker-milestone-nethost-"));
  const policyPath = join(dataDir, "capability-policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      appName: "plain-fetch-test-app",
      declaredCapabilities: ["network:host:example.com", "network:host:*.example.org"],
      writePaths: [],
      readPaths: [],
      networkPorts: [],
      networkUnrestricted: false,
    }),
  );

  const port = 58093;
  const broker = spawn(process.execPath, [BROKER_SCRIPT], {
    env: { ...process.env, BERTH_EGRESS_BROKER_PORT: String(port), BERTH_CAPABILITY_POLICY: policyPath },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  broker.stderr.on("data", (chunk) => (stderr += chunk.toString("utf-8")));

  try {
    await waitFor(() => stderr.includes("listening on"), 5000, "broker to start listening");
    console.log(stderr.trim());
    assert(stderr.includes("example.com") && stderr.includes("*.example.org"), "broker didn't log the network:host: patterns from a policy with no browser:navigate: capability at all");

    console.log("\n--- CONNECT to an in-scope host declared via network:host: (example.com) ---");
    const allowed = await connectThroughProxy(port, "example.com", 443);
    console.log(`status: ${allowed.statusCode}`);
    assert(allowed.statusCode === 200, `expected 200 for a network:host:-declared host, got ${allowed.statusCode}`);

    console.log("\n--- CONNECT to an out-of-scope host ---");
    const denied = await connectThroughProxy(port, "evil-not-declared.test", 443);
    console.log(`status: ${denied.statusCode}`);
    assert(denied.statusCode === 403, `expected 403 for an out-of-scope host, got ${denied.statusCode}`);

    console.log("\nPASS — network:host:<pattern> alone (no browser:navigate: capability) drives the exact same broker enforcement.");
  } finally {
    broker.kill();
    await rm(dataDir, { recursive: true, force: true });
  }
}

// Part A2: BERTH_EGRESS_UPSTREAM_PROXY chaining, against a real (if fake)
// second proxy — no Docker needed, same shape as Part A. Proves two things
// that matter about this feature specifically: an allowed CONNECT actually
// gets tunneled through the configured upstream (not silently ignored), with
// the right Proxy-Authorization credentials; and a denied host never even
// reaches the upstream proxy, so capability enforcement still runs first.
async function runPartA2() {
  console.log("\n=== Part A2: BERTH_EGRESS_UPSTREAM_PROXY chaining, run directly (no Docker) ===");
  const dataDir = await mkdtemp(join(tmpdir(), "berth-egress-broker-milestone-upstream-"));
  const policyPath = join(dataDir, "capability-policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      appName: "scoped-test-app",
      declaredCapabilities: ["browser:navigate:example.com"],
      writePaths: [],
      readPaths: [],
      networkPorts: [],
      networkUnrestricted: false,
    }),
  );

  const fakeUpstream = await startFakeUpstreamProxy();
  const brokerPort = 58091;
  const broker = spawn(process.execPath, [BROKER_SCRIPT], {
    env: {
      ...process.env,
      BERTH_EGRESS_BROKER_PORT: String(brokerPort),
      BERTH_CAPABILITY_POLICY: policyPath,
      BERTH_EGRESS_UPSTREAM_PROXY: `http://proxyuser:proxypass@127.0.0.1:${fakeUpstream.port}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  broker.stderr.on("data", (chunk) => (stderr += chunk.toString("utf-8")));

  try {
    await waitFor(() => stderr.includes("listening on"), 5000, "broker to start listening");
    assert(stderr.includes("chaining allowed CONNECTs through upstream proxy"), "broker didn't log that upstream chaining is active");

    console.log("\n--- CONNECT to an in-scope host (example.com), should tunnel through the fake upstream proxy ---");
    const allowed = await connectThroughProxy(brokerPort, "example.com", 443);
    console.log(`status: ${allowed.statusCode}`);
    assert(allowed.statusCode === 200, `expected 200 for an in-scope host chained through the upstream proxy, got ${allowed.statusCode}`);

    const receivedConnect = fakeUpstream.connects.find((c) => c.target === "example.com:443");
    assert(receivedConnect, `expected the fake upstream proxy to have received a CONNECT for example.com:443, got: ${JSON.stringify(fakeUpstream.connects)}`);
    const expectedAuth = `Basic ${Buffer.from("proxyuser:proxypass").toString("base64")}`;
    assert(
      receivedConnect.proxyAuthorization === expectedAuth,
      `expected the fake upstream proxy to see Proxy-Authorization: ${expectedAuth}, got: ${receivedConnect.proxyAuthorization}`,
    );

    console.log("\n--- CONNECT to an out-of-scope host — must be denied by the broker BEFORE reaching the upstream proxy ---");
    const denied = await connectThroughProxy(brokerPort, "evil-not-declared.test", 443);
    console.log(`status: ${denied.statusCode}`);
    assert(denied.statusCode === 403, `expected 403 for an out-of-scope host, got ${denied.statusCode}`);
    assert(
      !fakeUpstream.connects.some((c) => c.target === "evil-not-declared.test:443"),
      "the denied host reached the upstream proxy — capability enforcement must run before proxy chaining, not after",
    );

    console.log("\nPASS — an allowed CONNECT was really tunneled through the configured upstream proxy with the right credentials, and a denied host never reached it.");
  } finally {
    broker.kill();
    await fakeUpstream.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

// A minimal CONNECT-only proxy standing in for a real upstream (residential)
// proxy provider — real TCP, real HTTP/1.1 CONNECT framing, just not an
// actual third-party service. Records each CONNECT's target and
// Proxy-Authorization header for the test to assert against, then completes
// the tunnel with a 200 and immediately closes it — this test only needs to
// prove the broker reaches this proxy and hands it the right request, not
// that bytes flow end-to-end afterward (Part B already proves the direct
// no-upstream-proxy path carries real traffic).
async function startFakeUpstreamProxy() {
  const connects = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd);
      const [requestLine, ...headerLines] = header.split("\r\n");
      const target = requestLine?.split(" ")[1];
      const proxyAuthLine = headerLines.find((line) => /^proxy-authorization:/i.test(line));
      connects.push({ target, proxyAuthorization: proxyAuthLine?.split(":").slice(1).join(":").trim() });
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    connects,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function runPartB() {
  console.log("\n=== Part B: real browser-native sandbox, Chromium routed through the broker ===");
  const manifest = await loadManifest(join(BROWSER_NATIVE_APP_DIR, "berth.yml"));

  console.log("Building browser-native's dev image...");
  await buildImage({ appDir: BROWSER_NATIVE_APP_DIR, tag: "berth/browser-native:dev", target: "dev", docker });

  console.log("Starting browser-native's sandbox (headless, BERTH_TEST_MODE=1)...");
  const running = await startContainer({
    image: "berth/browser-native:dev",
    name: "berth-egress-broker-milestone-browser-native",
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: "/workspace/apps/browser-native",
    env: { BERTH_TEST_MODE: "1" },
    docker,
  });

  const containerLog = await startLogCapture(running.container);
  try {
    await waitFor(() => /\[egress-broker\] listening on/.test(containerLog.text()), 20000, "egress broker to start");
    await waitFor(() => /"browser-native" ready/.test(containerLog.text()), 20000, "browser-native runtime ready");

    const rpc = await createRpcClient(running.container);
    console.log("\n--- Navigating to a real page through the broker ---");
    const navigateResult = await rpc.call({ id: "1", export: "navigate", input: { url: "https://example.com" } });
    console.log("navigate response:", navigateResult);
    assert(!navigateResult.error, `expected navigate to succeed, got error: ${navigateResult.error}`);

    const textResult = await rpc.call({ id: "2", export: "get_page_text" });
    console.log("get_page_text response:", textResult);
    assert(!textResult.error, `expected get_page_text to succeed, got error: ${textResult.error}`);
    assert((textResult.result?.text ?? "").length > 0, "expected a non-empty page text — the real page didn't load");

    const brokerLog = containerLog.text().match(/\[egress-broker\] \{"event":"navigate_allowed".*example\.com.*$/m)?.[0];
    console.log("\nbroker allow-log line:", brokerLog ?? "(none found)");
    assert(brokerLog, "expected the broker's own allow-log for example.com — Chromium's traffic may be bypassing the broker entirely");

    rpc.close();
    console.log("\nPASS — Chromium's real navigation was actually routed through the egress broker, which allowed it and logged the decision.");
  } catch (err) {
    console.error("\n--- browser-native container log (Part B failure) ---");
    console.error(containerLog.text());
    throw err;
  } finally {
    await containerLog.stop();
    await stopContainer(running.container);
  }
}

// Part C: the real proof this isn't special-cased to browser-native. A
// completely different, non-Chromium resident app (examples/resident-apps/
// http-fetch — a plain fetch() export, no browser:* capability anywhere in
// its manifest) boots through the SAME entrypoint.sh path, gets the SAME
// egress broker started for it (because it declares network:host:*, not
// browser:navigate:*), and its own configureEgressProxy() call — one line
// in the app's own code, not a Chromium launch flag — is what actually
// routes its traffic through that broker.
async function runPartC() {
  console.log("\n=== Part C: real http-fetch sandbox (no browser:* capability at all), routed through the same broker ===");
  const manifest = await loadManifest(join(HTTP_FETCH_APP_DIR, "berth.yml"));

  console.log("Building http-fetch's dev image...");
  await buildImage({ appDir: HTTP_FETCH_APP_DIR, tag: "berth/http-fetch:dev", target: "dev", docker });

  console.log("Starting http-fetch's sandbox...");
  const running = await startContainer({
    image: "berth/http-fetch:dev",
    name: "berth-egress-broker-milestone-http-fetch",
    manifest,
    bindMount: { hostPath: REPO_ROOT, containerPath: "/workspace" },
    workingDir: "/workspace/examples/resident-apps/http-fetch",
    docker,
  });

  const containerLog = await startLogCapture(running.container);
  try {
    await waitFor(() => /\[egress-broker\] listening on/.test(containerLog.text()), 20000, "egress broker to start");
    assert(!/starting Xvfb/.test(containerLog.text()), "http-fetch declares no browser:* capability — Xvfb should never start for it");
    await waitFor(() => /"http-fetch" ready/.test(containerLog.text()), 20000, "http-fetch runtime ready");

    const rpc = await createRpcClient(running.container);
    console.log("\n--- fetch_text-ing a real URL through the broker ---");
    const fetchResult = await rpc.call({ id: "1", export: "fetch_text", input: { url: "https://example.com" } });
    console.log("fetch_text response:", { error: fetchResult.error, textLength: fetchResult.result?.text?.length });
    assert(!fetchResult.error, `expected fetch_text to succeed, got error: ${fetchResult.error}`);
    assert((fetchResult.result?.text ?? "").length > 0, "expected a non-empty response body — the real fetch didn't go through");

    const brokerLog = containerLog.text().match(/\[egress-broker\] \{"event":"navigate_allowed".*example\.com.*$/m)?.[0];
    console.log("\nbroker allow-log line:", brokerLog ?? "(none found)");
    assert(brokerLog, "expected the broker's own allow-log for example.com — http-fetch's traffic may be bypassing the broker entirely");

    rpc.close();
    console.log("\nPASS — a plain fetch()-based app with no browser:* capability at all got the same broker treatment browser-native does, via one configureEgressProxy() call.");
  } catch (err) {
    console.error("\n--- http-fetch container log (Part C failure) ---");
    console.error(containerLog.text());
    throw err;
  } finally {
    await containerLog.stop();
    await stopContainer(running.container);
  }
}

function connectThroughProxy(port, host, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\n\r\n`);
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const statusLine = buffer.split("\r\n")[0];
      const match = statusLine?.match(/^HTTP\/1\.1 (\d+)/);
      if (match) {
        socket.destroy();
        resolve({ statusCode: Number(match[1]) });
      }
    });
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error(`timed out waiting for a CONNECT response for ${host}:${targetPort}`));
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function startLogCapture(container) {
  const raw = await container.logs({ follow: true, stdout: true, stderr: true, tail: 0 });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(raw, stdout, stderr);

  let buffer = "";
  stdout.on("data", (chunk) => (buffer += chunk.toString("utf-8")));
  stderr.on("data", (chunk) => (buffer += chunk.toString("utf-8")));

  return { text: () => buffer, stop: async () => raw.destroy() };
}

async function createRpcClient(container) {
  const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);

  let buffer = "";
  const pending = new Map();

  stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        pending.get(parsed.id)?.(parsed);
        pending.delete(parsed.id);
      } catch {
        // not a JSON line — ignore
      }
    }
  });

  return {
    call(request) {
      return new Promise((resolve, reject) => {
        // Deliberately above Playwright's own default navigation timeout
        // (30000ms) — this call wraps a real page.goto() inside the
        // container, and with the two clocks equal there was no margin for
        // RPC/Docker-stdio round-trip overhead or CI's slower compute. A run
        // that's genuinely slow-but-working got killed by this timer before
        // Playwright's own timeout could produce a real, diagnosable error,
        // which is exactly what made a prior CI failure look like an opaque
        // hang instead of a clear navigation-timeout message.
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reject(new Error(`timed out waiting for RPC response to ${JSON.stringify(request)}`));
        }, 45000);
        pending.set(request.id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        stream.write(JSON.stringify(request) + "\n");
      });
    },
    close() {
      stream.end();
    },
  };
}

async function waitFor(predicate, timeoutMs, description) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for: ${description}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nEGRESS BROKER MILESTONE VERIFICATION FAILED:", err);
    process.exit(1);
  });
