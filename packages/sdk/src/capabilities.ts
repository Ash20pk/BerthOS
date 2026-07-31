import { createHash } from "node:crypto";
import * as path from "node:path";
import { loadManifest, matchesCapability, type CapabilityTokenRequest } from "@berth/manifest-schema";

export interface CapabilityGrant {
  granted: boolean;
  /**
   * A marker tying this grant to the app/capability/time it was checked —
   * NOT a real expiring, audited token yet (that needs the human-approval
   * service Phase 3 explicitly deferred; see docs/capability-tokens-reference.md).
   * `null` when denied.
   */
  token: string | null;
}

const MANIFEST_PATH = process.env.BERTH_MANIFEST_PATH ?? path.join(process.cwd(), "berth.yml");

// Loaded once per process — requestCapability() may be called many times
// and berth.yml doesn't change at runtime.
let declaredCapabilitiesPromise: Promise<string[]> | undefined;

function declaredCapabilities(): Promise<string[]> {
  declaredCapabilitiesPromise ??= loadManifest(MANIFEST_PATH).then((manifest) => manifest.capabilities);
  return declaredCapabilitiesPromise;
}

/**
 * Real as of Phase 3, for the one dimension actually kernel-enforced today:
 * filesystem writes. Reports whether `capability` is covered by berth.yml's
 * declared `capabilities:` — the same list agent-init already turned into an
 * enforced Landlock policy at boot (see generate-capability-policy.ts). This
 * function doesn't grant anything itself; the kernel already decided that at
 * process start. It just tells the caller honestly whether what they're
 * asking for was declared (and therefore enforced) — not, yet, whether a
 * human approved it, since that approval workflow is a deferred, separate
 * piece of scope.
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
    return { granted: false, token: null };
  }

  const token = createHash("sha256").update(`${appName}:${capability}:${request.requestedAt}`).digest("hex");
  console.debug(`[capabilities] granted`, request);
  return { granted: true, token };
}
