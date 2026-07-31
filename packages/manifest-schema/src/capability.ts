/**
 * Parses and matches "namespace:action:scope" capability strings.
 *
 * This module is pure data plumbing with zero enforcement: Phase 1 only logs
 * capability requests (see CapabilityTokenRequest below). Phase 3's
 * kernel-level capability-token issuer is expected to consume the exact same
 * ParsedCapability shape and matchesCapability() logic to decide grants —
 * building it now as a pure function means Phase 3 replaces the caller, not
 * this parser.
 */

export interface ParsedCapability {
  namespace: string;
  action: string;
  scope: string;
}

export function parseCapability(capability: string): ParsedCapability {
  const parts = capability.split(":");
  if (parts.length < 3) {
    throw new Error(`invalid capability string "${capability}": expected 'namespace:action:scope'`);
  }
  const [namespace, action, ...scopeParts] = parts;
  return { namespace: namespace!, action: action!, scope: scopeParts.join(":") };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Returns true if a `requested` capability is covered by a `granted` one.
 * Namespace and action must match exactly; scope may use `*` globs on the
 * granted side (e.g. granted "browser:navigate:*.github.com" matches
 * requested "browser:navigate:api.github.com").
 */
export function matchesCapability(granted: string, requested: string): boolean {
  const g = parseCapability(granted);
  const r = parseCapability(requested);
  if (g.namespace !== r.namespace || g.action !== r.action) return false;
  return globToRegExp(g.scope).test(r.scope);
}

/**
 * Inert scaffolding for Phase 3: a resident app's runtime records these as it
 * calls requestCapability(). Phase 1 only logs them (see @berth/sdk's
 * capabilities.ts); no policy engine reads this yet.
 */
export interface CapabilityTokenRequest {
  appName: string;
  capability: string;
  requestedAt: string;
}
