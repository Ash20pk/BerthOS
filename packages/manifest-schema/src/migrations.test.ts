import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "./validate.js";
import { migrateToCurrent, CURRENT_SCHEMA_VERSION } from "./migrations.js";

test("a manifest with no schema_version at all validates exactly as before (zero behavior change)", () => {
  const manifest = validateManifest({ name: "legacy-app", version: "1.0.0" });
  assert.equal(manifest.name, "legacy-app");
});

test("a manifest declaring the current schema_version validates unchanged", () => {
  const manifest = validateManifest({ name: "current-app", version: "1.0.0", schema_version: CURRENT_SCHEMA_VERSION });
  assert.equal(manifest.name, "current-app");
});

test("a manifest written against an OLDER schema_version migrates forward and validates", () => {
  // schema_version 0's hypothetical shape: `expose` was a single boolean
  // ("expose everything") rather than today's {browser, terminal, preview}
  // object — see migrations.ts's MIGRATIONS[0] doc comment.
  const manifest = validateManifest({
    name: "old-app",
    version: "1.0.0",
    schema_version: 0,
    expose: true,
  });
  assert.deepEqual(manifest.expose, { browser: true, terminal: true, preview: false });
});

test("migrateToCurrent walks a v0 boolean expose forward to today's object shape", () => {
  const migrated = migrateToCurrent({ name: "old-app", version: "1.0.0", expose: false }, 0);
  assert.deepEqual(migrated.expose, { browser: false, terminal: false, preview: false });
});

test("migrateToCurrent is a no-op when the declared version already equals current", () => {
  const raw = { name: "app", version: "1.0.0" };
  const migrated = migrateToCurrent(raw, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(migrated, raw);
});

test("a schema_version newer than this package supports fails with a clear, actionable error — never silent misinterpretation", () => {
  assert.throws(
    () => validateManifest({ name: "future-app", version: "1.0.0", schema_version: CURRENT_SCHEMA_VERSION + 1 }),
    /schema_version: \d+, but this installed @berth\/manifest-schema only supports up to \d+.*Upgrade @berth\/manifest-schema/s,
  );
});

test("a malformed schema_version (not a non-negative integer) fails clearly rather than being coerced", () => {
  assert.throws(() => validateManifest({ name: "bad-version-app", version: "1.0.0", schema_version: "latest" }), /schema_version must be a non-negative integer/);
  assert.throws(() => validateManifest({ name: "bad-version-app", version: "1.0.0", schema_version: -1 }), /schema_version must be a non-negative integer/);
  assert.throws(() => validateManifest({ name: "bad-version-app", version: "1.0.0", schema_version: 1.5 }), /schema_version must be a non-negative integer/);
});

test("migrateToCurrent throws a clear error for a version with no registered migration path, instead of silently returning it unchanged", () => {
  // -1 has no registered migration and never will — proves the walk fails
  // loudly rather than treating an unrecognized old version as already
  // current.
  assert.throws(() => migrateToCurrent({ name: "app", version: "1.0.0" }, -1), /no migration registered from schema_version -1 to 0/);
});
