#!/usr/bin/env node
// Path/verb-level enforcement for github:read:<scope> / github:write:<scope>
// capabilities (github:read:repos vs github:write:issues) — the gap
// egress-broker.cjs's own header comment names as needing real TLS
// interception, unlike host-level browser:navigate:<pattern> scoping.
//
// Unlike egress-broker.cjs (a transparent CONNECT relay — no decryption
// needed since it only ever inspects the cleartext CONNECT host:port line),
// this broker terminates TLS itself: it generates its own CA at startup,
// mints a leaf certificate for GITHUB_API_HOST signed by that CA, and
// completes the TLS handshake with the app's own HTTP client directly (the
// app must be configured to both route through this broker as an HTTP(S)
// proxy AND trust this CA — see docs/github-api-scoping-reference.md for
// exactly how apps/github-assistant does both). Once decrypted, an incoming
// request's real method+path are checked against the declared
// github:read:*/github:write:* capabilities (translated to a synthetic
// capability string and matched with the same glob logic egress-broker.cjs
// already duplicates from @berth/manifest-schema, for the same reason: this
// script runs standalone, outside any app's own node_modules resolution).
// Allowed requests are then re-encrypted as a brand new, real outbound TLS
// connection to the actual GitHub API (or, for the milestone test, a
// configurable upstream override) — this is a genuine decrypt/inspect/
// re-encrypt round trip, not a simulation.
//
// Scope: this broker only ever intercepts one fixed host (GITHUB_API_HOST)
// — a general-purpose "any host, any capability namespace" MITM framework
// is a much larger undertaking and is not attempted here.
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PORT = Number(process.env.BERTH_GITHUB_API_BROKER_PORT || 8092);
const POLICY_PATH = process.env.BERTH_CAPABILITY_POLICY || `${process.cwd()}/.berth/capability-policy.json`;
const CERT_DIR = process.env.BERTH_GITHUB_API_BROKER_CERT_DIR || "/tmp/berth-github-api-broker";
const CA_CERT_PATH = path.join(CERT_DIR, "ca.crt");

// The identity being intercepted/impersonated — fixed, since this is what a
// real app actually dials (CONNECT api.github.com:443) and what the leaf
// cert's CN/SAN and outbound Host header must say to look real either side.
const GITHUB_API_HOST = "api.github.com";
// Where the broker's own outbound leg actually connects — real GitHub by
// default. Overridable so the milestone test can redirect the *socket*
// dial at a local mock while GITHUB_API_HOST (interception target, cert
// identity, SNI, Host header) stays the real hostname throughout — the
// decrypt/decide/re-encrypt logic exercised is identical either way, only
// the final real-network destination changes.
const UPSTREAM_CONNECT_HOST = process.env.BERTH_GITHUB_API_UPSTREAM_HOST || GITHUB_API_HOST;
const UPSTREAM_CONNECT_PORT = Number(process.env.BERTH_GITHUB_API_UPSTREAM_PORT || 443);
const UPSTREAM_CA_PATH = process.env.BERTH_GITHUB_API_UPSTREAM_CA_PATH;

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

function matchesCapability(granted, requested) {
  const g = parseCapability(granted);
  const r = parseCapability(requested);
  if (!g || !r) return false;
  if (g.namespace !== r.namespace || g.action !== r.action) return false;
  return globToRegExp(g.scope).test(r.scope);
}

function loadGithubCapabilities() {
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(POLICY_PATH, "utf-8"));
  } catch (err) {
    console.error(`[github-api-broker] WARNING: couldn't read capability policy at ${POLICY_PATH} (${err.message}) — denying all requests`);
    return [];
  }
  return (policy.declaredCapabilities || []).filter((c) => {
    const parsed = parseCapability(c);
    return parsed && parsed.namespace === "github";
  });
}

const GITHUB_CAPABILITIES = loadGithubCapabilities();
console.error(`[github-api-broker] declared github:* capabilities: ${GITHUB_CAPABILITIES.join(", ") || "(none)"}`);

// v0 heuristic, not a full REST-API-aware grammar: GET/HEAD map to the
// "read" action, everything else to "write" — and the requested "scope" is
// the first path segment after /repos/<owner>/<repo>/ (e.g. "issues",
// "pulls"), or "repos" itself for a bare /repos/<owner>/<repo> request. This
// matches github-assistant's own two exports (get_repo_summary reads
// /repos/<owner>/<repo>, create_issue writes /repos/<owner>/<repo>/issues)
// for real, but is deliberately not a general GitHub API path grammar.
function requestedCapabilityFor(method, urlPath) {
  const action = method === "GET" || method === "HEAD" ? "read" : "write";
  const segments = (urlPath || "").split("?")[0].split("/").filter(Boolean);
  // segments[0] === "repos", segments[1] === owner, segments[2] === repo
  const scope = segments.length > 3 ? segments[3] : "repos";
  return `github:${action}:${scope}`;
}

function isAllowed(method, urlPath) {
  const requested = requestedCapabilityFor(method, urlPath);
  return GITHUB_CAPABILITIES.some((granted) => matchesCapability(granted, requested));
}

function generateCerts() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const caKey = path.join(CERT_DIR, "ca.key");
  const leafKey = path.join(CERT_DIR, "leaf.key");
  const leafCsr = path.join(CERT_DIR, "leaf.csr");
  const leafCert = path.join(CERT_DIR, "leaf.crt");
  const extFile = path.join(CERT_DIR, "leaf.ext");

  execFileSync("openssl", ["genrsa", "-out", caKey, "2048"], { stdio: "ignore" });
  execFileSync(
    "openssl",
    ["req", "-x509", "-new", "-key", caKey, "-sha256", "-days", "2", "-out", CA_CERT_PATH, "-subj", "/CN=Berth Local MITM CA"],
    { stdio: "ignore" },
  );
  execFileSync("openssl", ["genrsa", "-out", leafKey, "2048"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-new", "-key", leafKey, "-out", leafCsr, "-subj", `/CN=${GITHUB_API_HOST}`], { stdio: "ignore" });
  fs.writeFileSync(extFile, `subjectAltName=DNS:${GITHUB_API_HOST}\n`);
  execFileSync(
    "openssl",
    [
      "x509", "-req", "-in", leafCsr, "-CA", CA_CERT_PATH, "-CAkey", caKey, "-CAcreateserial",
      "-out", leafCert, "-days", "2", "-sha256", "-extfile", extFile,
    ],
    { stdio: "ignore" },
  );

  return { cert: fs.readFileSync(leafCert, "utf-8"), key: fs.readFileSync(leafKey, "utf-8") };
}

const { cert: LEAF_CERT, key: LEAF_KEY } = generateCerts();
console.error(`[github-api-broker] generated MITM CA at ${CA_CERT_PATH} (leaf cert for ${GITHUB_API_HOST})`);

function upstreamAgentOptions() {
  if (!UPSTREAM_CA_PATH) return {};
  // Test-only knob: trusts an additional CA for this broker's own outbound
  // leg, so the milestone test can redirect GITHUB_API_HOST to a local mock
  // HTTPS server without weakening TLS validation (rejectUnauthorized stays
  // true throughout — the mock's cert just needs a CA this broker trusts).
  return { ca: [...tls.rootCertificates, fs.readFileSync(UPSTREAM_CA_PATH, "utf-8")] };
}

function handleRequest(req, res) {
  const allowed = isAllowed(req.method, req.url);
  const requested = requestedCapabilityFor(req.method, req.url);

  if (!allowed) {
    console.error(`[github-api-broker] {"event":"denied","method":"${req.method}","path":"${req.url}","requested":"${requested}"}`);
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: `denied: no declared capability covers ${requested}` }));
    return;
  }
  console.error(`[github-api-broker] {"event":"allowed","method":"${req.method}","path":"${req.url}","requested":"${requested}"}`);

  const upstreamReq = https.request(
    {
      host: UPSTREAM_CONNECT_HOST,
      port: UPSTREAM_CONNECT_PORT,
      servername: GITHUB_API_HOST,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: GITHUB_API_HOST },
      ...upstreamAgentOptions(),
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on("error", (err) => {
    console.error(`[github-api-broker] upstream request error: ${err.message}`);
    res.writeHead(502, { "content-type": "text/plain" }).end("bad gateway");
  });
  req.pipe(upstreamReq);
}

// Parses decrypted HTTP off each intercepted TLS connection by handing it to
// a real http.Server's own connection handling — emitting 'connection'
// manually (rather than via listen()) reuses Node's HTTP request parser
// against an already-TLS-wrapped socket instead of a raw accepted one.
const requestParser = http.createServer(handleRequest);

const proxyServer = http.createServer((req, res) => {
  res.writeHead(400, { "content-type": "text/plain" }).end("this broker only accepts CONNECT requests");
});

proxyServer.on("connect", (req, clientSocket, head) => {
  const [host] = (req.url || "").split(":");

  if (host !== GITHUB_API_HOST) {
    console.error(`[github-api-broker] {"event":"connect_denied","host":${JSON.stringify(host)}}`);
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }

  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head && head.length > 0) clientSocket.unshift(head);

  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    cert: LEAF_CERT,
    key: LEAF_KEY,
  });
  tlsSocket.on("error", (err) => console.error(`[github-api-broker] TLS handshake error: ${err.message}`));
  tlsSocket.on("secure", () => requestParser.emit("connection", tlsSocket));
});

proxyServer.listen(PORT, "127.0.0.1", () => {
  console.error(`[github-api-broker] listening on 127.0.0.1:${PORT}, intercepting ${GITHUB_API_HOST}`);
});
