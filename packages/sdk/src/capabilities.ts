import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { loadManifest, matchesCapability, type CapabilityTokenRequest } from "@berth/manifest-schema";

export interface CapabilityGrant {
  granted: boolean;
  /** HMAC-signed, expiring — see signToken()/verifyCapabilityToken() below. `null` when denied. */
  token: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  /**
   * True if this denial was submitted to a berth-grants server
   * (BERTH_GRANTS_SERVER_URL) as a pending request for human approval — see
   * `berth grants list/approve/deny`. Approval takes effect on this app's
   * NEXT container restart (generate-capability-policy.ts re-reads approved
   * grants at boot), never live — Landlock rulesets can't be widened once
   * applied to a running process.
   */
  pending?: boolean;
}

const MANIFEST_PATH = process.env.BERTH_MANIFEST_PATH ?? path.join(process.cwd(), "berth.yml");
// Same default generate-capability-policy.ts itself uses — this is the file
// it writes at boot, merging berth.yml's static `capabilities:` with
// whatever's been approved via `berth grants approve` since.
const CAPABILITY_POLICY_PATH = process.env.BERTH_CAPABILITY_POLICY ?? path.join(process.cwd(), ".berth", "capability-policy.json");
const TOKEN_TTL_MS = 5 * 60 * 1000;
const GRANTS_SERVER_URL = process.env.BERTH_GRANTS_SERVER_URL;

/** Best-effort: an unreachable/misconfigured grants server never blocks the caller, just skips the pending-request step. */
async function submitPendingGrant(appName: string, capability: string): Promise<boolean> {
  if (!GRANTS_SERVER_URL) return false;
  try {
    const res = await fetch(new URL("/grants", GRANTS_SERVER_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appName, capability }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch (err) {
    console.error(`[capabilities] WARNING: couldn't submit pending grant to ${GRANTS_SERVER_URL} (${err})`);
    return false;
  }
}

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

/**
 * The policy file's `declaredCapabilities` is berth.yml's static list merged
 * with whatever's been approved via `berth grants approve` since (see
 * generate-capability-policy.ts's `main()`) — reading it, rather than
 * berth.yml directly, is what lets requestCapability() ever see an approved
 * grant at all. Returns undefined (not an empty array) when the file isn't
 * there or isn't parseable JSON, so the caller can fall back to berth.yml
 * rather than treating "no policy file" as "nothing is granted."
 */
async function readPolicyDeclaredCapabilities(): Promise<string[] | undefined> {
  try {
    const raw = await readFile(CAPABILITY_POLICY_PATH, "utf-8");
    const policy = JSON.parse(raw) as { declaredCapabilities?: unknown };
    return Array.isArray(policy.declaredCapabilities) ? (policy.declaredCapabilities as string[]) : undefined;
  } catch {
    return undefined;
  }
}

// Loaded once per process — requestCapability() may be called many times
// and neither berth.yml nor the policy file change at runtime.
let declaredCapabilitiesPromise: Promise<string[]> | undefined;

function declaredCapabilities(): Promise<string[]> {
  declaredCapabilitiesPromise ??= (async () => {
    const fromPolicy = await readPolicyDeclaredCapabilities();
    if (fromPolicy) return fromPolicy;
    // No policy file (running outside a real Berth container — e.g. a unit
    // test, or before generate-capability-policy.ts has run at boot) — fall
    // back to berth.yml's own static list, same as this function's original
    // behavior before the policy file existed.
    const manifest = await loadManifest(MANIFEST_PATH);
    return manifest.capabilities;
  })();
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
    const pending = await submitPendingGrant(appName, capability);
    console.debug(`[capabilities] denied`, request, pending ? "(submitted for human approval)" : "(not declared in berth.yml)");
    return { granted: false, token: null, issuedAt: null, expiresAt: null, pending };
  }

  const issuedAt = request.requestedAt;
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const token = signToken(`${appName}:${capability}:${issuedAt}:${expiresAt}`);
  console.debug(`[capabilities] granted`, request, `expiresAt=${expiresAt}`);
  return { granted: true, token, issuedAt, expiresAt };
}
