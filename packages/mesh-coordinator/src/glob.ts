/**
 * Mirrors @berth/manifest-schema's capability.ts globToRegExp exactly (same
 * `*` -> `.*` translation) — deliberately reimplemented rather than
 * depended-on: peer names aren't necessarily berth app names, and this
 * package shouldn't need to understand the full `namespace:action:scope`
 * capability grammar just to compare two bare name globs.
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** True if any pattern in `patterns` matches `name` (glob semantics, `*` allowed). */
export function matchesAny(patterns: string[], name: string): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(name));
}
