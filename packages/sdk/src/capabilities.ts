import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { loadManifest, matchesCapability, type CapabilityRequest } from "@berthos/manifest-schema";

export interface CapabilityGrant {
  granted: boolean;
}

const MANIFEST_PATH = process.env.BERTH_MANIFEST_PATH ?? path.join(process.cwd(), "berth.yml");
// Same default generate-capability-policy.ts itself uses — this is the file
// it writes at boot from berth.yml's `capabilities:`, and the one agent-init
// and the brokers enforce against.
const CAPABILITY_POLICY_PATH = process.env.BERTH_CAPABILITY_POLICY ?? path.join(process.cwd(), ".berth", "capability-policy.json");

/**
 * The policy file's `declaredCapabilities` is the list that was actually
 * compiled into this boot's enforced policy, so it is the authority on what
 * is granted; berth.yml is the fallback for a process running outside a real
 * Berth container. Returns undefined (not an empty array) when the file isn't
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
 * that at process start, and this reports what that decision was.
 *
 * It used to also return an HMAC-signed, expiring capability token. That was
 * removed: nothing in Berth ever verified one, and it
 * could not have meant anything if it had. The signing secret was exported
 * into the app's own environment, so the constrained process held the key and
 * could mint any token for any capability; in multi-app containers each app
 * got a *different* secret, so cross-app verification was impossible by
 * construction. Cross-app identity is now established by the kernel at
 * connect(2) instead, which an app cannot forge,
 * and which is what a token would have been trying to approximate.
 */
export async function requestCapability(appName: string, capability: string): Promise<CapabilityGrant> {
  const request: CapabilityRequest = {
    appName,
    capability,
    requestedAt: new Date().toISOString(),
  };

  const declared = await declaredCapabilities();
  const granted = declared.some((grantedCapability) => matchesCapability(grantedCapability, capability));

  if (!granted) {
    console.debug(`[capabilities] denied`, request, "(not declared in berth.yml)");
    return { granted: false };
  }

  console.debug(`[capabilities] granted`, request);
  return { granted: true };
}
