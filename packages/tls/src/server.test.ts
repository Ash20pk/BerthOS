import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveServerTls, resolveServerTlsFromEnv, schemeFor } from "./server.js";

function fixture(): { certPath: string; keyPath: string; caPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "berth-tls-"));
  const certPath = join(dir, "server.crt");
  const keyPath = join(dir, "server.key");
  const caPath = join(dir, "ca.crt");
  writeFileSync(certPath, "CERT");
  writeFileSync(keyPath, "KEY");
  writeFileSync(caPath, "CA");
  return { certPath, keyPath, caPath };
}

test("returns undefined when nothing is configured", () => {
  assert.equal(resolveServerTls({}), undefined);
});

test("loads a cert and key", () => {
  const { certPath, keyPath } = fixture();
  assert.deepEqual(resolveServerTls({ certPath, keyPath }), { cert: "CERT", key: "KEY", ca: undefined });
});

test("rejects a cert without a key, and a key without a cert", () => {
  const { certPath, keyPath } = fixture();
  assert.throws(() => resolveServerTls({ certPath }), /both a certificate and a key/);
  assert.throws(() => resolveServerTls({ keyPath }), /both a certificate and a key/);
});

test("throws on an unreadable path rather than serving plain HTTP", () => {
  const { keyPath } = fixture();
  // The failure mode this prevents: a typo'd path silently degrading a
  // deployment that believes it enabled TLS.
  assert.throws(
    () => resolveServerTls({ certPath: "/nope/missing.crt", keyPath }),
    /refusing to start rather than falling back to plain HTTP/,
  );
});

test("refuses a CA or client-cert requirement with no cert and key at all", () => {
  const { caPath } = fixture();
  assert.throws(() => resolveServerTls({ caPath }), /refusing to start/);
  assert.throws(() => resolveServerTls({ requireClientCert: true }), /refusing to start/);
});

test("mTLS is off unless asked for", () => {
  const { certPath, keyPath, caPath } = fixture();
  const tls = resolveServerTls({ certPath, keyPath, caPath })!;
  assert.equal(tls.requestCert, undefined);
  assert.equal(tls.rejectUnauthorized, undefined);
});

test("mTLS sets requestCert and rejectUnauthorized when asked for", () => {
  const { certPath, keyPath, caPath } = fixture();
  const tls = resolveServerTls({ certPath, keyPath, caPath, requireClientCert: true })!;
  assert.equal(tls.requestCert, true);
  assert.equal(tls.rejectUnauthorized, true);
  assert.equal(tls.ca, "CA");
});

test("requiring a client cert without a CA is an error, not a silently unverified one", () => {
  const { certPath, keyPath } = fixture();
  assert.throws(() => resolveServerTls({ certPath, keyPath, requireClientCert: true }), /needs a CA to verify it against/);
});

test("reads paths from prefixed environment variables", () => {
  const { certPath, keyPath, caPath } = fixture();
  const tls = resolveServerTlsFromEnv("BERTH_GRANTS", {
    BERTH_GRANTS_TLS_CERT: certPath,
    BERTH_GRANTS_TLS_KEY: keyPath,
    BERTH_GRANTS_TLS_CA: caPath,
    BERTH_GRANTS_TLS_REQUIRE_CLIENT_CERT: "true",
  })!;
  assert.equal(tls.cert, "CERT");
  assert.equal(tls.requestCert, true);
});

test("an env with no TLS variables yields no TLS", () => {
  assert.equal(resolveServerTlsFromEnv("BERTH_GRANTS", {}), undefined);
});

test("schemeFor names the scheme a server should print", () => {
  assert.equal(schemeFor(undefined), "http");
  assert.equal(schemeFor({ cert: "c", key: "k" }), "https");
});
