import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { loadManifest, matchesCapability, type CapabilityRequest } from "@berth/manifest-schema";

export interface CapabilityGrant {
  granted: boolean;
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
 * that at process start, and this reports what that decision was.
 *
 * It used to also return an HMAC-signed, expiring capability token. That was
 * removed in REMEDIATION.md 1.10: nothing in Berth ever verified one, and it
 * could not have meant anything if it had. The signing secret was exported
 * into the app's own environment, so the constrained process held the key and
 * could mint any token for any capability; in multi-app containers each app
 * got a *different* secret, so cross-app verification was impossible by
 * construction. Cross-app identity is now established by the kernel at
 * connect(2) instead — see REMEDIATION.md 1.4 — which an app cannot forge,
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
    const pending = await submitPendingGrant(appName, capability);
    console.debug(`[capabilities] denied`, request, pending ? "(submitted for human approval)" : "(not declared in berth.yml)");
    return { granted: false, pending };
  }

  console.debug(`[capabilities] granted`, request);
  return { granted: true };
}
