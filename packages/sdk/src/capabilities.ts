import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as path from "node:path";
import { loadManifest, matchesCapability, type CapabilityTokenRequest } from "@berth/manifest-schema";

export interface CapabilityGrant {
  granted: boolean;
  /** HMAC-signed, expiring — see signToken()/verifyCapabilityToken() below. `null` when denied. */
  token: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
}

const MANIFEST_PATH = process.env.BERTH_MANIFEST_PATH ?? path.join(process.cwd(), "berth.yml");
const TOKEN_TTL_MS = 5 * 60 * 1000;

// Generated once per container boot by entrypoint.sh and inherited via the
// environment — see docker/entrypoint.sh. Falls back to a process-local
// random value (still HMAC'd, just not shared across processes) so this
// module doesn't hard-fail when run outside a real Berth container (e.g.
// unit tests) — that fallback is NOT meaningful cross-process verification.
const TOKEN_SECRET = process.env.BERTH_TOKEN_SECRET ?? randomBytes(32).toString("hex");

function signToken(payload: string): string {
  return createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex");
}

/** Recomputes the HMAC and checks expiry — real, independently-verifiable, not just a marker. */
export function verifyCapabilityToken(
  appName: string,
  capability: string,
  issuedAt: string,
  expiresAt: string,
  token: string,
): boolean {
  if (Date.now() > Date.parse(expiresAt)) return false;
  const expected = signToken(`${appName}:${capability}:${issuedAt}:${expiresAt}`);
  const expectedBuf = Buffer.from(expected, "hex");
  const tokenBuf = Buffer.from(token, "hex");
  return expectedBuf.length === tokenBuf.length && timingSafeEqual(expectedBuf, tokenBuf);
}

// Loaded once per process — requestCapability() may be called many times
// and berth.yml doesn't change at runtime.
let declaredCapabilitiesPromise: Promise<string[]> | undefined;

function declaredCapabilities(): Promise<string[]> {
  declaredCapabilitiesPromise ??= loadManifest(MANIFEST_PATH).then((manifest) => manifest.capabilities);
  return declaredCapabilitiesPromise;
}

/**
 * Real as of Phase 3, for filesystem writes (and, as of this pass, opt-in
 * read/network scoping — see generate-capability-policy.ts). Reports whether
 * `capability` is covered by berth.yml's declared `capabilities:` — the same
 * list agent-init already turned into an enforced Landlock policy at boot.
 * This function doesn't grant anything itself; the kernel already decided
 * that at process start. It returns a real HMAC-signed, expiring token (see
 * verifyCapabilityToken() above) for whatever consumes it next.
 */
export async function requestCapability(appName: string, capability: string): Promise<CapabilityGrant> {
  const request: CapabilityTokenRequest = {
    appName,
    capability,
    requestedAt: new Date().toISOString(),
  };

  const declared = await declaredCapabilities();
  const granted = declared.some((grantedCapability) => matchesCapability(grantedCapability, capability));

  if (!granted) {
    console.debug(`[capabilities] denied`, request, "(not declared in berth.yml)");
    return { granted: false, token: null, issuedAt: null, expiresAt: null };
  }

  const issuedAt = request.requestedAt;
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const token = signToken(`${appName}:${capability}:${issuedAt}:${expiresAt}`);
  console.debug(`[capabilities] granted`, request, `expiresAt=${expiresAt}`);
  return { granted: true, token, issuedAt, expiresAt };
}
