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
const dns = require("node:dns").promises;

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
  // `?` is escaped along with the rest — it is a regex quantifier, so an
  // unescaped one made "a?.example.com" mean "optional a", matching
  // ".example.com" and anything ending in it. Only `*` is a wildcard here.
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

// What a browser actually needs, and the ceiling for a capability that names
// no port. `CONNECT internal-db.corp:5432` through this broker used to
// succeed for an app declaring `browser:navigate:*` — the port was parsed,
// passed to net.connect, and never checked against anything (REMEDIATION.md
// 1.8). Widen it deliberately by declaring the port in the scope:
// `network:host:internal-db.corp:5432`, or `:*` for any.
const DEFAULT_ALLOWED_PORTS = [80, 443];

/**
 * Splits a capability scope into its host pattern and optional port pattern.
 * The port is the part after the LAST colon, and only when it looks like a
 * port — so "example.com" and "*" keep the default port set, while
 * "example.com:5432" and "example.com:*" name their own.
 */
function parseScope(scope) {
  const lastColon = scope.lastIndexOf(":");
  if (lastColon > 0) {
    const suffix = scope.slice(lastColon + 1);
    if (suffix === "*" || /^\d+$/.test(suffix)) {
      return { hostPattern: scope.slice(0, lastColon), portPattern: suffix };
    }
  }
  return { hostPattern: scope, portPattern: null };
}

// Read once at startup: the policy file is fixed at container boot (same
// file agent-init reads), never regenerated mid-run. Recognizes both
// capability names (see the file header) — a resident app declares
// whichever reads better for what it's doing; the broker treats them
// identically.
function loadPolicy() {
  try {
    return JSON.parse(fs.readFileSync(POLICY_PATH, "utf-8"));
  } catch (err) {
    console.error(`[egress-broker] WARNING: couldn't read capability policy at ${POLICY_PATH} (${err.message}) — denying all navigation`);
    return null;
  }
}

const POLICY = loadPolicy();

function loadAllowedHostPatterns() {
  const policy = POLICY;
  if (!policy) return [];
  return (policy.declaredCapabilities || [])
    .map(parseCapability)
    .filter((c) => c && ((c.namespace === "browser" && c.action === "navigate") || (c.namespace === "network" && c.action === "host")))
    .map((c) => parseScope(c.scope));
}

// Hosts another broker in this container enforces at a finer grain than a
// host name — REMEDIATION.md 1.9. github-api-broker.cjs terminates TLS for
// api.github.com so it can tell `GET /repos/o/r` from `GET /user/emails`;
// an app declaring `github:read:repos` AND `network:host:*` used to get a raw
// CONNECT api.github.com:443 through this broker as well, with no path or
// verb inspection at all — the coarse capability silently undoing the fine
// one. Where a dedicated broker exists, it is the only way to that host.
//
// Conditional on the app having declared a github:* capability, because that
// is exactly when entrypoint.sh starts that broker. An app that declared no
// github:* capability has no dedicated broker running and no path-level
// policy to bypass; refusing it would just be a host this product cannot
// reach.
function loadDedicatedBrokerHosts() {
  const declared = POLICY?.declaredCapabilities || [];
  const hasGithubCapability = declared.some((c) => parseCapability(c)?.namespace === "github");
  return hasGithubCapability ? new Set(["api.github.com"]) : new Set();
}

const DEDICATED_BROKER_HOSTS = loadDedicatedBrokerHosts();
const ALLOWED_HOST_PATTERNS = loadAllowedHostPatterns();
console.error(
  `[egress-broker] allowed host patterns (browser:navigate:*/network:host:*): ${
    ALLOWED_HOST_PATTERNS.map(({ hostPattern, portPattern }) => `${hostPattern}:${portPattern ?? DEFAULT_ALLOWED_PORTS.join("|")}`).join(", ") ||
    "(none)"
  }`,
);
if (DEDICATED_BROKER_HOSTS.size > 0) {
  console.error(`[egress-broker] refusing hosts owned by a dedicated broker: ${[...DEDICATED_BROKER_HOSTS].join(", ")}`);
}
if (UPSTREAM_PROXY_URL) {
  console.error(`[egress-broker] chaining allowed CONNECTs through upstream proxy ${UPSTREAM_PROXY_URL.hostname}:${UPSTREAM_PROXY_URL.port || 80}`);
}

/**
 * The name check. A pattern matches only if BOTH its host glob and its port
 * allowance cover the request — a pattern that names no port covers 80 and
 * 443 only.
 */
function isHostAllowed(host, port) {
  return ALLOWED_HOST_PATTERNS.some(({ hostPattern, portPattern }) => {
    if (!globToRegExp(hostPattern).test(host)) return false;
    if (portPattern === null) return DEFAULT_ALLOWED_PORTS.includes(port);
    if (portPattern === "*") return true;
    return Number(portPattern) === port;
  });
}

/**
 * Addresses no declared capability can reach, `*` included — REMEDIATION.md
 * 1.8. `browser:navigate:*` reads as "any site on the internet", and a
 * reasonable person declaring it does not mean "and the cloud metadata
 * service, and anything on the Docker bridge, and the host itself".
 *
 * This is the SSRF half. `169.254.169.254` is IMDS on AWS/GCP/Azure and hands
 * out instance credentials to anything that can make an HTTP request;
 * `host.docker.internal` is wired to `host-gateway` by container.ts, so it
 * reaches services on the developer's own machine.
 *
 * Checked against the resolved *address*, not the name, because a name is
 * whoever controls the DNS record's to choose.
 */
function isBlockedAddress(ip) {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true;
  const [a, b] = octets;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback — the broker's own port, and every other app's
  if (a === 169 && b === 254) return true; // link-local, and IMDS at 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918, incl. the default Docker bridge
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * Resolves once and returns the address to dial, so the check and the dial
 * cannot disagree.
 *
 * Checking the *name* and then handing that name to net.connect lets the
 * resolver run a second time, and a DNS record whose answer changes between
 * the two — classic rebinding — turns an allowed name into an internal
 * address. Pinning removes the second lookup entirely: what was validated is
 * what gets dialled.
 */
async function resolvePinnedAddress(host) {
  // An IP literal needs no lookup, and must still face the block list.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;

  // resolve4() rather than lookup(): lookup() goes through getaddrinfo, which
  // on Alpine/musl races A and AAAA queries and can stall indefinitely when
  // IPv6 is in /etc/resolv.conf but not routable — the same bug the `family: 4`
  // notes elsewhere in this file exist to dodge, and passing `family: 4` to
  // lookup() does not dodge it. Caught in a real container: every CONNECT
  // logged nothing at all, because the await never settled and so neither
  // branch was ever reached. resolve4() is c-ares, sends an A query, and
  // never consults getaddrinfo.
  //
  // The timeout is belt-and-braces on top: a resolver that hangs anyway
  // produces a diagnosable error instead of a silent stall.
  const addresses = await Promise.race([
    dns.resolve4(host),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`DNS lookup for ${host} timed out`)), 5000)),
  ]);
  if (!addresses || addresses.length === 0) throw new Error(`no A record for ${host}`);
  return addresses[0];
}

// Connection-scoped headers, which belong to the hop they arrived on and
// must not be forwarded to the next one (RFC 9110 §7.6.1). Forwarding them
// lets a caller influence how the broker's own upstream connection behaves —
// and `proxy-authorization` in particular is this broker's credential to the
// upstream proxy, not something a request should be able to supply.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Strips hop-by-hop headers and normalizes Host to the target this broker
 * actually validated — REMEDIATION.md 1.8.
 *
 * Host matters because the request line and the Host header can disagree: a
 * request for an allowed URL carrying `Host: internal-service` is checked
 * against one and, at many upstreams, routed by the other. Normalizing means
 * what was authorized is what is asked for.
 */
function sanitizeForwardedHeaders(headers, hostHeaderValue) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  out.host = hostHeaderValue;
  return out;
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
/**
 * A throw inside an async handler is an unhandled rejection, and Node exits
 * the process on those — so one bad request would take egress down for every
 * app in the container, and the browser would report the proxy as
 * unreachable rather than the request as refused. Caught here: the request
 * fails closed, the broker keeps serving. (This is not a licence to ignore
 * the throw — it is logged loudly.)
 */
function denyOnThrow(handler, onError) {
  return (...args) => {
    Promise.resolve(handler(...args)).catch((err) => {
      console.error(`[egress-broker] handler error, denying this request: ${err.stack || err.message}`);
      try {
        onError(...args);
      } catch {
        // the connection is already gone; nothing further to do
      }
    });
  };
}

const server = http.createServer(
  denyOnThrow(
    async (req, res) => {
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" }).end("bad request: expected an absolute-URI (proxy request)");
    return;
  }

  const targetPort = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  if (DEDICATED_BROKER_HOSTS.has(target.hostname)) {
    logDecision("denied", target.hostname, targetPort);
    console.error(`[egress-broker] {"event":"dedicated_broker_host","host":${JSON.stringify(target.hostname)},"port":${targetPort}}`);
    res
      .writeHead(403, { "content-type": "text/plain" })
      .end(`egress denied: "${target.hostname}" is enforced by a dedicated broker in this container, which is the only route to it`);
    return;
  }
  if (!isHostAllowed(target.hostname, targetPort)) {
    logDecision("denied", target.hostname, targetPort);
    res
      .writeHead(403, { "content-type": "text/plain" })
      .end(`egress denied: "${target.hostname}:${targetPort}" is not covered by any declared browser:navigate:<pattern>/network:host:<pattern> capability`);
    return;
  }

  // Same pinning as the CONNECT path, and skipped for the same reason when an
  // upstream proxy is doing the resolving.
  let address = null;
  if (!UPSTREAM_PROXY_URL) {
    try {
      address = await resolvePinnedAddress(target.hostname);
    } catch (err) {
      logDecision("denied", target.hostname, targetPort);
      res.writeHead(502, { "content-type": "text/plain" }).end(`egress failed: could not resolve "${target.hostname}" (${err.message})`);
      return;
    }
    if (isBlockedAddress(address)) {
      logDecision("denied", target.hostname, targetPort);
      console.error(
        `[egress-broker] {"event":"blocked_address","host":${JSON.stringify(target.hostname)},"address":${JSON.stringify(address)},"port":${targetPort}}`,
      );
      res
        .writeHead(403, { "content-type": "text/plain" })
        .end(`egress denied: "${target.hostname}" resolves to ${address}, which is loopback, private, link-local, or otherwise internal`);
      return;
    }
  }
  logDecision("allowed", target.hostname, targetPort);

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
    ? { hostname: UPSTREAM_PROXY_URL.hostname, port: Number(UPSTREAM_PROXY_URL.port) || 80, path: req.url }
    : // Dial the pinned address, but keep the Host header as the name the
      // caller asked for, so virtual hosts still work.
      { hostname: address, port: targetPort, path: `${target.pathname}${target.search}` };
  const forwardedHeaders = sanitizeForwardedHeaders(req.headers, target.host);
  // One options object, not (target, options): the three-argument form of
  // http.request() requires a URL or string first, and this used to pass the
  // `target` URL. Handing it a plain options object instead makes Node read
  // the second argument as the callback and throw — which, in an async
  // handler, is an unhandled rejection that takes the whole broker down and
  // surfaces to the browser as ERR_PROXY_CONNECTION_FAILED.
  const upstream = http.request(
    {
      ...upstreamTarget,
      method: req.method,
      headers: UPSTREAM_PROXY_AUTH_VALUE ? { ...forwardedHeaders, "proxy-authorization": UPSTREAM_PROXY_AUTH_VALUE } : forwardedHeaders,
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
    },
    (_req, res) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }).end("egress broker error");
    },
  ),
);

// HTTPS proxying: CONNECT establishes a raw tunnel after the host:port check
// — bytes flow unmodified in both directions once allowed, so this never
// sees (and doesn't need to see) anything inside the TLS session.
server.on(
  "connect",
  denyOnThrow(
    async (req, clientSocket, head) => {
  const [host, portStr] = (req.url || "").split(":");
  const port = Number(portStr) || 443;

  if (DEDICATED_BROKER_HOSTS.has(host)) {
    logDecision("denied", host, port);
    console.error(`[egress-broker] {"event":"dedicated_broker_host","host":${JSON.stringify(host)},"port":${port}}`);
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }

  if (!host || !isHostAllowed(host, port)) {
    logDecision("denied", host, port);
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }

  if (UPSTREAM_PROXY_URL) {
    // No address check on this path, deliberately: the upstream proxy makes
    // the outbound connection and does its own resolution, so there is no
    // address here to validate. The name check above is what applies.
    logDecision("allowed", host, port);
    connectViaUpstreamProxy(host, port, clientSocket, head);
    return;
  }

  let address;
  try {
    address = await resolvePinnedAddress(host);
  } catch (err) {
    logDecision("denied", host, port);
    console.error(`[egress-broker] could not resolve ${host}: ${err.message}`);
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    return;
  }
  if (isBlockedAddress(address)) {
    logDecision("denied", host, port);
    console.error(`[egress-broker] {"event":"blocked_address","host":${JSON.stringify(host)},"address":${JSON.stringify(address)},"port":${port}}`);
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
  // The pinned address, not the name — a second lookup here is what DNS
  // rebinding needs, and there isn't one.
  const upstream = net.connect({ host: address, port, family: 4 });
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
    },
    (_req, clientSocket) => {
      if (!clientSocket.destroyed) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    },
  ),
);

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
