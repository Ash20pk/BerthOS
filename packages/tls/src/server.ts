import { readFileSync } from "node:fs";

/**
 * What a Fastify/`node:https` server needs to serve TLS. Shaped to be passed
 * straight to `Fastify({ https })` or `https.createServer()`.
 */
export interface ServerTlsOptions {
  cert: string;
  key: string;
  /**
   * Extra CAs used to verify *client* certificates. Only meaningful together
   * with `requestCert` — see resolveServerTls's note on mTLS.
   */
  ca?: string;
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
}

export interface TlsPaths {
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  /** Require and verify a client certificate against `caPath`. */
  requireClientCert?: boolean;
}

/**
 * Loads a certificate and key off disk, or returns undefined when neither is
 * configured.
 *
 * Returning undefined rather than throwing is what lets every server take the
 * same "TLS if configured, plain HTTP otherwise" shape without each one
 * re-deciding. What it must never do is *silently* fall back: a deployment
 * that meant to enable TLS and typo'd a path would then serve cleartext while
 * believing otherwise, which is worse than not offering TLS at all. So a
 * half-configured pair (cert without key, or either path unreadable) is a
 * hard error.
 */
export function resolveServerTls(paths: TlsPaths): ServerTlsOptions | undefined {
  const { certPath, keyPath, caPath, requireClientCert } = paths;
  if (!certPath && !keyPath) {
    if (caPath || requireClientCert) {
      throw new Error("a TLS CA or client-certificate requirement was configured without a cert and key — refusing to start, since this would serve plain HTTP while looking configured");
    }
    return undefined;
  }
  if (!certPath || !keyPath) {
    throw new Error(`TLS needs both a certificate and a key (got ${certPath ? "only a certificate" : "only a key"})`);
  }

  const cert = read(certPath, "certificate");
  const key = read(keyPath, "key");
  const ca = caPath ? read(caPath, "CA bundle") : undefined;

  if (requireClientCert && !ca) {
    throw new Error("requiring a client certificate needs a CA to verify it against");
  }

  return {
    cert,
    key,
    ca,
    // Mutual TLS is opt-in and off by default. It is the right control for
    // service-to-service traffic and the wrong one to impose on an operator
    // running `berth grants approve` from a laptop, who has no client cert
    // and no way to get one — there is no CA to issue them from
    // (REMEDIATION.md 5.2: no identity system exists yet).
    ...(requireClientCert ? { requestCert: true, rejectUnauthorized: true } : {}),
  };
}

function read(path: string, what: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`could not read TLS ${what} at ${path} (${err}) — refusing to start rather than falling back to plain HTTP`);
  }
}

/**
 * Reads TLS paths from a server's own environment variables:
 * `<PREFIX>_TLS_CERT`, `<PREFIX>_TLS_KEY`, `<PREFIX>_TLS_CA`, and
 * `<PREFIX>_TLS_REQUIRE_CLIENT_CERT`.
 */
export function resolveServerTlsFromEnv(prefix: string, env: NodeJS.ProcessEnv = process.env): ServerTlsOptions | undefined {
  return resolveServerTls({
    certPath: env[`${prefix}_TLS_CERT`],
    keyPath: env[`${prefix}_TLS_KEY`],
    caPath: env[`${prefix}_TLS_CA`],
    requireClientCert: isTrue(env[`${prefix}_TLS_REQUIRE_CLIENT_CERT`]),
  });
}

function isTrue(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/** "https" when TLS is on, "http" otherwise — for the URL a server prints at startup. */
export function schemeFor(tls: ServerTlsOptions | undefined): "http" | "https" {
  return tls ? "https" : "http";
}
