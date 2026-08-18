import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GeneratedCerts {
  caCertPath: string;
  certPath: string;
  keyPath: string;
}

export interface GenerateOptions {
  /** Directory to write into. Created 0700. */
  dir: string;
  /** Hostnames and IPs the certificate is valid for. Defaults to localhost plus 127.0.0.1 and ::1. */
  hosts?: string[];
  /** Certificate lifetime. Default 365. */
  days?: number;
  /** Regenerate even if files already exist. */
  force?: boolean;
}

/**
 * Mints a local CA and a leaf certificate for a Berth server, by shelling out
 * to `openssl` — the same approach `docker/github-api-broker.cjs` already
 * uses, rather than pulling in a certificate library for a dev-only path.
 *
 * **These are for development and closed internal networks.** A self-signed
 * CA means every client has to be told to trust it (`--ca`,
 * `NODE_EXTRA_CA_CERTS`), which is exactly the friction that makes people
 * disable verification instead — so nothing here generates a cert on the fly
 * or trusts one automatically. For anything reachable from a network you do
 * not control, bring a certificate from a real CA and point
 * `<PREFIX>_TLS_CERT`/`_KEY` at it; that path involves none of this file.
 */
export function generateSelfSignedCerts(options: GenerateOptions): GeneratedCerts {
  const { dir, days = 365, force = false } = options;
  const hosts = options.hosts?.length ? options.hosts : ["localhost", "127.0.0.1", "::1"];

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask, and a pre-existing directory keeps
  // whatever mode it already had — so set it explicitly. The private keys
  // below live here.
  chmodSync(dir, 0o700);

  const caKey = join(dir, "ca.key");
  const caCert = join(dir, "ca.crt");
  const key = join(dir, "server.key");
  const csr = join(dir, "server.csr");
  const cert = join(dir, "server.crt");
  const ext = join(dir, "server.ext");

  if (!force && existsSync(caCert) && existsSync(cert) && existsSync(key)) {
    return { caCertPath: caCert, certPath: cert, keyPath: key };
  }

  requireOpenssl();

  run(["genrsa", "-out", caKey, "2048"]);
  run(["req", "-x509", "-new", "-key", caKey, "-sha256", "-days", String(days), "-out", caCert, "-subj", "/CN=Berth Local CA"]);

  run(["genrsa", "-out", key, "2048"]);
  run(["req", "-new", "-key", key, "-out", csr, "-subj", `/CN=${hosts[0]}`]);
  // A SAN list is not optional: every current TLS client ignores CN entirely,
  // so a cert without this verifies against nothing and fails with an error
  // that names the hostname rather than the missing extension.
  writeFileSync(ext, `subjectAltName=${hosts.map(sanEntry).join(",")}\n`);
  run([
    "x509", "-req", "-in", csr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial",
    "-out", cert, "-days", String(days), "-sha256", "-extfile", ext,
  ]);

  for (const secret of [caKey, key]) chmodSync(secret, 0o600);
  // The CA cert is public by design — clients need it to verify, and it
  // grants nothing on its own. The CA *key* beside it mints certificates for
  // any host, which is why it stays 0600 in a 0700 directory.
  chmodSync(caCert, 0o644);
  chmodSync(cert, 0o644);

  return { caCertPath: caCert, certPath: cert, keyPath: key };
}

function sanEntry(host: string): string {
  return isIpAddress(host) ? `IP:${host}` : `DNS:${host}`;
}

/**
 * An IP in a SAN must be tagged `IP:`, not `DNS:` — a `DNS:127.0.0.1` entry
 * is silently accepted by openssl and then never matches, because clients
 * compare a literal IP against iPAddress entries only.
 */
function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function requireOpenssl(): void {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
  } catch {
    throw new Error("openssl is not on PATH — install it, or bring your own certificate and set the TLS cert/key paths directly");
  }
}

function run(args: string[]): void {
  execFileSync("openssl", args, { stdio: "ignore" });
}
