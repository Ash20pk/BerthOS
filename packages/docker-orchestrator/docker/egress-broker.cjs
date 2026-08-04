#!/usr/bin/env node
// Host-level egress enforcement for browser:navigate:<pattern> AND
// network:host:<pattern> capabilities — the same mechanism, two capability
// names for the same real thing ("this app may reach hosts matching this
// pattern"). browser:navigate:* is apps/browser-native's own name for it
// (kept for backward compat — Chromium's --proxy-server flag already points
// here); network:host:* is the generic form ANY resident app can declare,
// not just one that also drives a browser, so this one broker is a
// capability every app can opt into identically rather than something
// wired specifically for Chromium's launch flag. A CONNECT tunnel's target
// host:port is visible in cleartext by protocol design (that's the whole
// point of CONNECT), so this needs no TLS interception/CA machinery to
// enforce host-level scoping — see docs/capability-tokens-reference.md.
// Path/verb-level API scoping (github:read:repos vs github:write:issues)
// would need real decryption and is a deliberately different, harder
// mechanism — see docs/github-api-scoping-reference.md — not something
// this broker (or network:host:*) attempts.
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

// Optional: chain an *allowed* CONNECT through a further upstream proxy
// (e.g. a residential/rotating proxy provider) instead of connecting to the
// target directly — lets any app using this broker (browser-native via
// Chromium's launch flag, or a plain fetch()-based app via
// configureEgressProxy(), see @berth/sdk) present a real residential IP to
// sites that block/challenge datacenter ranges, without weakening
// browser:navigate:<pattern>/network:host:<pattern> enforcement: the
// host-allow check above still runs first, so a denied host never reaches
// (or costs bandwidth on) the upstream proxy either. Format: a proxy URL,
// credentials optional —
// "http://user:pass@residential-proxy.example.com:8000". Deliberately not
// logged verbatim anywhere below (credentials would leak into container
// logs) — only host:port ever gets logged. Any provider that speaks plain
// HTTP CONNECT + optional Proxy-Authorization: Basic works here; that's the
// standard interface Bright Data/Oxylabs/Smartproxy/etc. all expose.
const UPSTREAM_PROXY_URL = process.env.BERTH_EGRESS_UPSTREAM_PROXY ? new URL(process.env.BERTH_EGRESS_UPSTREAM_PROXY) : null;
// The "Basic <base64>" value only — callers add whichever header-name/CRLF
// shape their own protocol (raw CONNECT vs. Node's http.request headers) needs.
const UPSTREAM_PROXY_AUTH_VALUE = UPSTREAM_PROXY_URL?.username
  ? `Basic ${Buffer.from(`${decodeURIComponent(UPSTREAM_PROXY_URL.username)}:${decodeURIComponent(UPSTREAM_PROXY_URL.password)}`).toString("base64")}`
  : null;

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
// file agent-init reads), never regenerated mid-run. Recognizes both
// capability names (see the file header) — a resident app declares
// whichever reads better for what it's doing; the broker treats them
// identically.
function loadAllowedHostPatterns() {
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(POLICY_PATH, "utf-8"));
  } catch (err) {
    console.error(`[egress-broker] WARNING: couldn't read capability policy at ${POLICY_PATH} (${err.message}) — denying all navigation`);
    return [];
  }
  return (policy.declaredCapabilities || [])
    .map(parseCapability)
    .filter((c) => c && ((c.namespace === "browser" && c.action === "navigate") || (c.namespace === "network" && c.action === "host")))
    .map((c) => c.scope);
}

const ALLOWED_HOST_PATTERNS = loadAllowedHostPatterns();
console.error(`[egress-broker] allowed host patterns (browser:navigate:*/network:host:*): ${ALLOWED_HOST_PATTERNS.join(", ") || "(none)"}`);
if (UPSTREAM_PROXY_URL) {
  console.error(`[egress-broker] chaining allowed CONNECTs through upstream proxy ${UPSTREAM_PROXY_URL.hostname}:${UPSTREAM_PROXY_URL.port || 80}`);
}

function isHostAllowed(host) {
  return ALLOWED_HOST_PATTERNS.some((pattern) => globToRegExp(pattern).test(host));
}

function logDecision(action, host, port) {
  const viaUpstream = action === "allowed" && Boolean(UPSTREAM_PROXY_URL);
  console.error(
    `[egress-broker] {"event":"navigate_${action}","host":${JSON.stringify(host)},"port":${port},"viaUpstreamProxy":${viaUpstream}}`,
  );
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
      .end(`egress denied: "${target.hostname}" is not covered by any declared browser:navigate:<pattern>/network:host:<pattern> capability`);
    return;
  }
  logDecision("allowed", target.hostname, target.port || 80);

  // family: 4 sidesteps a musl/Alpine resolver bug where a bare hostname's
  // races A/AAAA lookups and can stall far longer than any sane timeout when
  // IPv6 is listed in /etc/resolv.conf but not actually routable (see the
  // 'connect' handler below for the full writeup); the explicit `timeout`
  // turns a stalled upstream into a fast, diagnosable error instead of an
  // indefinite hang.
  //
  // When an upstream proxy is configured, forward this same absolute-URI
  // request line to it (a plain-HTTP forward-proxy request already names
  // its target via the URI, not the connection) instead of connecting to
  // the target directly — the upstream proxy is what makes the outbound
  // connection, and thus what the target site sees as the source IP.
  const upstreamTarget = UPSTREAM_PROXY_URL
    ? { hostname: UPSTREAM_PROXY_URL.hostname, port: UPSTREAM_PROXY_URL.port || 80, path: req.url }
    : target;
  const upstream = http.request(
    upstreamTarget,
    {
      method: req.method,
      headers: UPSTREAM_PROXY_AUTH_VALUE ? { ...req.headers, "proxy-authorization": UPSTREAM_PROXY_AUTH_VALUE } : req.headers,
      family: 4,
      timeout: 10000,
    },
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

  if (UPSTREAM_PROXY_URL) {
    connectViaUpstreamProxy(host, port, clientSocket, head);
    return;
  }

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

/**
 * Tunnels an already-allowed CONNECT through UPSTREAM_PROXY_URL instead of
 * connecting to `host:port` directly: connect to the upstream proxy, issue
 * our own CONNECT for the real target (proxy-chaining — standard, not
 * Berth-specific), then splice the client socket to the upstream socket
 * exactly as the direct path does once *that* tunnel is confirmed. The
 * host-allow check has already run by the time this is called, so a denied
 * host never reaches (or spends the upstream proxy's bandwidth/cost) here.
 */
function connectViaUpstreamProxy(host, port, clientSocket, head) {
  const proxyHost = UPSTREAM_PROXY_URL.hostname;
  const proxyPort = Number(UPSTREAM_PROXY_URL.port) || 80;

  const upstream = net.connect({ host: proxyHost, port: proxyPort, family: 4 });
  const connectTimeout = setTimeout(() => {
    upstream.destroy(new Error(`connect to upstream proxy ${proxyHost}:${proxyPort} timed out`));
  }, 10000);

  function fail(message) {
    clearTimeout(connectTimeout);
    console.error(`[egress-broker] ${message}`);
    if (!clientSocket.destroyed) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    upstream.destroy();
  }

  upstream.once("connect", () => {
    const authLine = UPSTREAM_PROXY_AUTH_VALUE ? `Proxy-Authorization: ${UPSTREAM_PROXY_AUTH_VALUE}\r\n` : "";
    upstream.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${authLine}\r\n`);
  });

  // Buffers only the upstream proxy's own CONNECT response headers (a few
  // hundred bytes at most) — once the blank-line terminator is seen, this
  // listener detaches and the socket goes back to raw byte-piping for the
  // rest of the tunnel's lifetime, same as the direct path.
  let responseBuffer = Buffer.alloc(0);
  function onUpstreamData(chunk) {
    responseBuffer = Buffer.concat([responseBuffer, chunk]);
    const headerEnd = responseBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    upstream.off("data", onUpstreamData);
    clearTimeout(connectTimeout);

    const statusLine = responseBuffer.subarray(0, headerEnd).toString("utf-8").split("\r\n")[0] ?? "";
    const statusCode = Number(statusLine.match(/^HTTP\/1\.\d (\d+)/)?.[1]);
    if (statusCode !== 200) {
      fail(`upstream proxy refused CONNECT ${host}:${port}: ${statusLine}`);
      return;
    }

    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    // Any bytes the upstream proxy sent immediately after its own header
    // terminator are already tunnel payload (rare, but the framing allows
    // it) — forward them before splicing the two sockets together.
    const leftover = responseBuffer.subarray(headerEnd + 4);
    if (leftover.length > 0) clientSocket.write(leftover);
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  }
  upstream.on("data", onUpstreamData);

  upstream.on("error", (err) => fail(`upstream proxy connect error for ${proxyHost}:${proxyPort}: ${err.message}`));
  clientSocket.on("error", () => upstream.destroy());
}

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[egress-broker] listening on 127.0.0.1:${PORT}`);
});
