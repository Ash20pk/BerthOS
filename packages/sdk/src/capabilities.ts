import type { CapabilityTokenRequest } from "@berth/manifest-schema";

export interface CapabilityGrant {
  granted: boolean;
  /** Always null in Phase 1 — Phase 3's kernel token issuer populates this. */
  token: string | null;
}

/**
 * Inert Phase 1 stub: every request is granted unconditionally and only
 * logged, never enforced. Phase 3 replaces this implementation with a call
 * that blocks on human admin approval and returns a scoped, expiring token
 * enforced at the kernel syscall boundary — resident app call sites using
 * requestCapability() do not change when that happens.
 */
export async function requestCapability(appName: string, capability: string): Promise<CapabilityGrant> {
  const request: CapabilityTokenRequest = {
    appName,
    capability,
    requestedAt: new Date().toISOString(),
  };
  console.debug(`[capabilities:stub] requested`, request, "(granted unconditionally — Phase 3 will enforce this)");
  return { granted: true, token: null };
}
