#!/usr/bin/env node
// Host-level egress enforcement for browser:navigate:<pattern> capabilities
// — the one non-filesystem capability type that has a real consumer today
// (apps/browser-native). A CONNECT tunnel's target host:port is visible in
// cleartext by protocol design (that's the whole point of CONNECT), so this
// needs no TLS interception/CA machinery to enforce host-level scoping —
// see docs/capability-tokens-reference.md. Path/verb-level API scoping
// (github:read:repos vs github:write:issues) would need real decryption and
// is deliberately not attempted here.
//
// Runs from a fixed /usr/local/bin location, outside any app's own
// node_modules resolution — same reason rpc-relay.js has zero external
// dependencies, so the capability-string parsing below duplicates (not
// imports) @berth/manifest-schema's parseCapability/matchesCapability.
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");

const PORT = Number(process.env.BERTH_EGRESS_BROKER_PORT || 8090);
const POLICY_PATH = process.env.BERTH_CAPABILITY_POLICY || `${process.cwd()}/.berth/capability-policy.json`;

function parseCapability(capability) {
  const parts = capability.split(":");
  if (parts.length < 3) return null;
  const [namespace, action, ...scopeParts] = parts;
  return { namespace, action, scope: scopeParts.join(":") };
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

// Read once at startup: the policy file is fixed at container boot (same
// file agent-init reads), never regenerated mid-run.
function loadNavigatePatterns() {
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(POLICY_PATH, "utf-8"));
  } catch (err) {
    console.error(`[egress-broker] WARNING: couldn't read capability policy at ${POLICY_PATH} (${err.message}) — denying all navigation`);
    return [];
  }
  return (policy.declaredCapabilities || [])
    .map(parseCapability)
    .filter((c) => c && c.namespace === "browser" && c.action === "navigate")
    .map((c) => c.scope);
}

const NAVIGATE_PATTERNS = loadNavigatePatterns();
console.error(`[egress-broker] allowed browser:navigate patterns: ${NAVIGATE_PATTERNS.join(", ") || "(none)"}`);

function isHostAllowed(host) {
  return NAVIGATE_PATTERNS.some((pattern) => globToRegExp(pattern).test(host));
}

function logDecision(action, host, port) {
  console.error(`[egress-broker] {"event":"navigate_${action}","host":${JSON.stringify(host)},"port":${port}}`);
}

// Plain-HTTP proxying (absolute-URI request line) — same host check as
// CONNECT, for completeness. browser-native's real traffic is almost all
// HTTPS (handled below via 'connect'), but a proxy that only handled CONNECT
// would silently pass plain http:// navigations through unchecked.
const server = http.createServer((req, res) => {
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" }).end("bad request: expected an absolute-URI (proxy request)");
    return;
  }

  if (!isHostAllowed(target.hostname)) {
    logDecision("denied", target.hostname, target.port || 80);
    res
      .writeHead(403, { "content-type": "text/plain" })
      .end(`egress denied: "${target.hostname}" is not covered by any declared browser:navigate:<pattern> capability`);
    return;
  }
  logDecision("allowed", target.hostname, target.port || 80);

  // family: 4 sidesteps a musl/Alpine resolver bug where a bare hostname's
  // races A/AAAA lookups and can stall far longer than any sane timeout when
  // IPv6 is listed in /etc/resolv.conf but not actually routable (see the
  // 'connect' handler below for the full writeup); the explicit `timeout`
  // turns a stalled upstream into a fast, diagnosable error instead of an
  // indefinite hang.
  const upstream = http.request(
    target,
    { method: req.method, headers: req.headers, family: 4, timeout: 10000 },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  req.pipe(upstream);
  upstream.on("timeout", () => upstream.destroy(new Error("upstream connect timed out")));
  upstream.on("error", (err) => res.destroy(err));
});

// HTTPS proxying: CONNECT establishes a raw tunnel after the host:port check
// — bytes flow unmodified in both directions once allowed, so this never
// sees (and doesn't need to see) anything inside the TLS session.
server.on("connect", (req, clientSocket, head) => {
  const [host, portStr] = (req.url || "").split(":");
  const port = Number(portStr) || 443;

  if (!host || !isHostAllowed(host)) {
    logDecision("denied", host, port);
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  logDecision("allowed", host, port);

  // family: 4 forces IPv4 resolution instead of letting Node's musl/Alpine
  // resolver race A/AAAA lookups — a well-documented class of bug
  // (alpinelinux/docker-alpine#399, #203) where that race can stall for tens
  // of seconds when IPv6 is listed in /etc/resolv.conf but not actually
  // routable, which reads from the RPC caller's side as an indefinite hang
  // rather than an error. A connect-only timeout (cleared once connected, so
  // it never cuts off a legitimately long-lived tunnel) turns a stalled
  // upstream into a fast, diagnosable error instead.
  const upstream = net.connect({ host, port, family: 4 });
  const connectTimeout = setTimeout(() => {
    upstream.destroy(new Error(`connect to ${host}:${port} timed out`));
  }, 10000);
  upstream.once("connect", () => {
    clearTimeout(connectTimeout);
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", (err) => {
    clearTimeout(connectTimeout);
    console.error(`[egress-broker] upstream connect error for ${host}:${port}: ${err.message}`);
    if (!clientSocket.destroyed) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  clientSocket.on("error", () => upstream.destroy());
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[egress-broker] listening on 127.0.0.1:${PORT}`);
});
