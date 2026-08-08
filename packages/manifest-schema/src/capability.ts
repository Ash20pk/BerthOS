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

/**
 * The only path prefixes a `filesystem:read:<path>`/`filesystem:write:<path>`
 * capability may name.
 *
 * This is not cosmetic validation. agent-init runs `create_dir_all()` on every
 * declared path as uid 0 with CAP_SYS_ADMIN *before* it applies the Landlock
 * ruleset (see packages/agent-init/src/main.rs), and `berth dev` bind-mounts
 * the host workspace, so an unconstrained scope means a manifest — one from
 * the registry, or from a PR — could name any path in the container (or on the
 * developer's host) and both have it created and be granted write access
 * beneath it. `filesystem:write:/` used to be accepted silently and grants the
 * entire container filesystem.
 *
 * The four entries are exactly the paths that exist for an app to use:
 * `/workspace` (the app's working tree), `/context` (the semantic-FS FUSE
 * mount), `/tmp` (scratch, already an unconditional write baseline), and
 * `/app` (a single-app container's own directory — `berth dev` mounts the app
 * there, and companions live under `/workspace/<rel>`; see
 * packages/cli/src/util/workspace.ts).
 *
 * Kept here in @berth/manifest-schema rather than in the compiler so the
 * manifest schema, @berth/sdk's generate-capability-policy.ts, and anything
 * else that inspects capabilities all reject the same set — agent-init
 * re-checks its write paths independently in Rust, deliberately duplicating
 * this list, because it is the process actually doing the mkdir as root.
 */
export const ALLOWED_FILESYSTEM_SCOPE_PREFIXES = ["/workspace", "/context", "/tmp", "/app"];

/**
 * Returns a human-readable reason a `filesystem:` capability scope is not
 * allowed, or `undefined` if it's fine. Only meaningful for the `filesystem`
 * namespace — every other namespace's scope is a host glob, a repo name, a
 * port, or a peer name, none of which are paths.
 */
export function filesystemScopeIssue(scope: string): string | undefined {
  if (scope.includes("\0")) return "filesystem path must not contain a null byte";
  if (!scope.startsWith("/")) return `filesystem path must be absolute (start with "/"), got ${JSON.stringify(scope)}`;

  // A trailing "/*" is the one glob that means something here: the policy
  // compiler strips it and grants the directory itself (Landlock grants are
  // always recursive beneath a path, so "/workspace" and "/workspace/*" are
  // the same ruleset). Any other "*" is not a glob at all by the time it
  // reaches agent-init — it becomes a literal directory named "*", which
  // create_dir_all() then creates. `filesystem:write:*` was the worst case:
  // not absolute, so it's now caught by the check above.
  const path = scope.endsWith("/*") ? scope.slice(0, -2) : scope;
  if (path.includes("*")) {
    return `filesystem path may only use a trailing "/*" glob (a "*" anywhere else becomes a literal directory name), got ${JSON.stringify(scope)}`;
  }
  if (path === "/") {
    return `filesystem:*:/ would grant the entire container filesystem — declare a path under ${ALLOWED_FILESYSTEM_SCOPE_PREFIXES.join(", ")} instead`;
  }

  const segments = path.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `filesystem path must be canonical — no empty, "." or ".." segments, and no trailing slash — got ${JSON.stringify(scope)}`;
  }

  const allowed = ALLOWED_FILESYSTEM_SCOPE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  if (!allowed) {
    return `filesystem path must be ${ALLOWED_FILESYSTEM_SCOPE_PREFIXES.join(", ")} or a path beneath one of them, got ${JSON.stringify(scope)}`;
  }
  return undefined;
}

/**
 * Returns a reason `capability` is not an acceptable declaration, or
 * `undefined` if it is. Assumes the "namespace:action:scope" grammar already
 * holds (see CapabilityString in schema.ts) — this is the semantic layer on
 * top of it.
 */
export function capabilityIssue(capability: string): string | undefined {
  let parsed: ParsedCapability;
  try {
    parsed = parseCapability(capability);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (parsed.namespace === "filesystem" && (parsed.action === "read" || parsed.action === "write")) {
    return filesystemScopeIssue(parsed.scope);
  }
  return undefined;
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
