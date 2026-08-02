/**
 * berth.yml's `schema_version` — distinct from `version` (the app's own
 * semver, used as its Docker image tag). Every berth.yml written before
 * this field existed has none at all, and MUST keep validating exactly as
 * it always has: absent `schema_version` is treated as the CURRENT version,
 * not as some ambiguous "version 0" — see validate.ts's readSchemaVersion().
 *
 * Bump this whenever BerthManifestSchema changes in a way that isn't purely
 * additive-with-a-default (i.e. whenever an old, valid berth.yml would stop
 * parsing under the new schema without a migration) — see
 * docs/manifest-reference.md for the full compatibility policy. Register the
 * migration that brings the old shape forward in MIGRATIONS below in the
 * same change.
 */
export const CURRENT_SCHEMA_VERSION = 1;

type RawManifest = Record<string, unknown>;
type Migration = (raw: RawManifest) => RawManifest;

/**
 * Keyed by the version a migration starts FROM — MIGRATIONS[3] takes a
 * version-3-shaped object and returns a version-4-shaped one. Applied in
 * sequence by migrateToCurrent() below, so a manifest several versions
 * behind walks forward one step at a time rather than needing a direct
 * old-to-current transform for every possible pair.
 *
 * No real berth.yml in this repo has ever declared `schema_version: 0` —
 * BerthManifestSchema's shape today IS version 1, unchanged since Phase 1.
 * MIGRATIONS[0] exists purely as the reference implementation for the next
 * REAL breaking change to follow, added proactively (see docs/manifest-
 * reference.md) rather than improvised under pressure the first time an
 * old manifest actually needs one. It models a plausible breaking change —
 * `expose` starting out as a single "expose everything" boolean before
 * becoming today's per-capability {browser, terminal, preview} object —
 * without that ever having been a real shape this project shipped.
 */
const MIGRATIONS: Record<number, Migration> = {
  0: (raw) => {
    if (typeof raw.expose !== "boolean") return raw;
    const exposeEverything = raw.expose;
    return { ...raw, expose: { browser: exposeEverything, terminal: exposeEverything, preview: false } };
  },
};

/**
 * Walks a manifest forward from its declared version to CURRENT_SCHEMA_VERSION,
 * one registered migration at a time. Throws — rather than silently
 * returning the input unchanged — if any step in that walk has no
 * registered migration, since misinterpreting an old shape as the current
 * one is exactly the failure mode this exists to prevent (see docs/manifest-
 * reference.md: "fail with a clear, actionable error — never silent
 * misinterpretation").
 */
export function migrateToCurrent(raw: RawManifest, declaredVersion: number): RawManifest {
  let migrated = raw;
  for (let v = declaredVersion; v < CURRENT_SCHEMA_VERSION; v++) {
    const migration = MIGRATIONS[v];
    if (!migration) {
      throw new Error(
        `no migration registered from schema_version ${v} to ${v + 1} — this berth.yml declares schema_version: ${declaredVersion}, ` +
          `but this installed @berth/manifest-schema (current version ${CURRENT_SCHEMA_VERSION}) doesn't know how to bring it forward. ` +
          `Upgrade @berth/manifest-schema, or migrate this berth.yml to schema_version: ${CURRENT_SCHEMA_VERSION} by hand.`,
      );
    }
    migrated = migration(migrated);
  }
  return migrated;
}
