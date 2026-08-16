import { readFileSync } from "node:fs";
import { Agent, setGlobalDispatcher } from "undici";

/**
 * Makes this process's `fetch()` trust a CA that isn't in the system store —
 * the self-signed one `berth tls init` mints, or a private internal CA.
 *
 * Node's global `fetch` and the npm `undici` package share a dispatcher
 * through the same well-known global symbol, so setting it here applies to
 * plain `fetch()` calls made anywhere afterwards. `@berth/sdk`'s
 * `egress-proxy.ts` relies on the same property.
 *
 * `NODE_EXTRA_CA_CERTS=/path/to/ca.crt` does the same thing without any code
 * and is the better answer when you can set an environment variable, since it
 * covers every TLS client in the process rather than only `fetch`. This
 * exists for the CLI, where the CA arrives as a `--ca` flag.
 */
export function trustCa(caPath: string): void {
  let ca: string;
  try {
    ca = readFileSync(caPath, "utf-8");
  } catch (err) {
    throw new Error(`could not read CA certificate at ${caPath} (${err})`);
  }
  setGlobalDispatcher(new Agent({ connect: { ca } }));
}

/**
 * Turns off certificate verification for this process's `fetch()`.
 *
 * Deliberately loud, deliberately awkward to reach, and never the default: a
 * client that does not verify is doing the handshake and getting none of the
 * guarantee, which is worse than plain HTTP in one specific way — it looks
 * secure. Anything long-lived should trust a CA instead.
 */
export function disableTlsVerification(): void {
  console.error("[berth] WARNING: TLS certificate verification is DISABLED — the connection is encrypted but unauthenticated, and trivially interceptable. Use --ca with a real CA certificate instead.");
  setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));
}

export interface ClientTlsFlags {
  ca?: string;
  insecure?: boolean;
}

/**
 * Applies `--ca` / `--insecure` before a command makes any request. Call once
 * at the top of a CLI command.
 */
export function applyClientTls(flags: ClientTlsFlags): void {
  if (flags.ca) trustCa(flags.ca);
  else if (flags.insecure) disableTlsVerification();
}

/**
 * Warns when an operator credential is about to cross a plain-HTTP
 * connection to somewhere other than this machine.
 *
 * Loopback is exempt because the token never touches a network there, and
 * warning about it would train people to ignore the warning that matters.
 * REMEDIATION.md 5.3's concrete case is `berth deploy --grants-server`, where
 * the URL has to be reachable *from the fleet* — so it is remote by
 * definition, and every approval crosses it in the clear.
 */
export function warnIfCredentialOverPlaintext(url: string, what = "a credential"): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:") return;
  if (isLoopback(parsed.hostname)) return;
  console.error(`[berth] WARNING: sending ${what} to ${parsed.origin} over plain HTTP — it crosses the network in the clear. Use https:// (see docs/tls-reference.md).`);
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}
