import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFleet } from "./fleet.js";

test("resolveFleet defaults to count 1 for the bare e2b/daytona names", async () => {
  const e2b = await resolveFleet("e2b");
  assert.equal(e2b.adapter.name, "e2b");
  assert.equal(e2b.count, 1);

  const daytona = await resolveFleet("daytona");
  assert.equal(daytona.adapter.name, "daytona");
  assert.equal(daytona.count, 1);
});

test("resolveFleet reads count from a ~/.berthrc alias", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-fleet-test-"));
  const configPath = join(dir, ".berthrc");
  try {
    await writeFile(configPath, JSON.stringify({ prod: { adapter: "e2b", count: 5 } }));
    const resolved = await resolveFleet("prod", configPath);
    assert.equal(resolved.adapter.name, "e2b");
    assert.equal(resolved.count, 5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveFleet defaults an alias with no count to 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-fleet-test-"));
  const configPath = join(dir, ".berthrc");
  try {
    await writeFile(configPath, JSON.stringify({ staging: { adapter: "daytona" } }));
    const resolved = await resolveFleet("staging", configPath);
    assert.equal(resolved.count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveFleet throws a clear error for an unknown alias", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-fleet-test-"));
  const configPath = join(dir, ".berthrc");
  try {
    await writeFile(configPath, JSON.stringify({ prod: { adapter: "e2b" } }));
    await assert.rejects(() => resolveFleet("nonexistent", configPath), /unknown fleet "nonexistent"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveFleet passes through env from the alias", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-fleet-test-"));
  const configPath = join(dir, ".berthrc");
  try {
    await writeFile(configPath, JSON.stringify({ prod: { adapter: "e2b", env: { FOO: "bar" } } }));
    const resolved = await resolveFleet("prod", configPath);
    assert.deepEqual(resolved.env, { FOO: "bar" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveFleet passes through region from the alias, and leaves it undefined when unset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-fleet-test-"));
  const configPath = join(dir, ".berthrc");
  try {
    await writeFile(configPath, JSON.stringify({ prod: { adapter: "daytona", region: "eu-central-1" }, staging: { adapter: "e2b" } }));
    const prod = await resolveFleet("prod", configPath);
    assert.equal(prod.region, "eu-central-1");
    const staging = await resolveFleet("staging", configPath);
    assert.equal(staging.region, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * REMEDIATION.md 5.5: `~/.berthrc` is where a fleet alias's provider API keys
 * live, and it was read at whatever mode it happened to have — 0644 by
 * default, which on a shared machine is every local account's copy of the
 * credentials for every remote sandbox this one can start.
 */
async function withCapturedWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

test("resolveFleet warns when a credential-carrying ~/.berthrc is readable by other users", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-fleet-test-"));
  const configPath = join(dir, ".berthrc");
  try {
    await writeFile(configPath, JSON.stringify({ prod: { adapter: "e2b", env: { ANTHROPIC_API_KEY: "sk-ant-test" } } }), { mode: 0o644 });
    await chmod(configPath, 0o644);

    const { result, warnings } = await withCapturedWarnings(() => resolveFleet("prod", configPath));

    // Still resolves — this is a warning, not a refusal: failing here would
    // break every existing --fleet invocation on upgrade.
    assert.deepEqual(result.env, { ANTHROPIC_API_KEY: "sk-ant-test" });
    assert.equal(warnings.length, 1, `expected exactly one warning, got ${JSON.stringify(warnings)}`);
    assert.match(warnings[0]!, /readable by other users/);
    assert.match(warnings[0]!, new RegExp(`chmod 600 ${configPath}`));
    // The warning must not print the thing it is warning about.
    assert.ok(!warnings[0]!.includes("sk-ant-test"), "the warning leaked the credential it was warning about");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveFleet stays quiet for a 0600 config, and for a loose one that carries no env at all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-fleet-test-"));
  try {
    const tight = join(dir, ".berthrc-tight");
    await writeFile(tight, JSON.stringify({ prod: { adapter: "e2b", env: { ANTHROPIC_API_KEY: "sk-ant-test" } } }));
    await chmod(tight, 0o600);
    const tightRun = await withCapturedWarnings(() => resolveFleet("prod", tight));
    assert.deepEqual(tightRun.warnings, []);

    // A name-to-adapter map with no env is not a credential file, and warning
    // about it would train people to ignore the warning that matters.
    const loose = join(dir, ".berthrc-loose");
    await writeFile(loose, JSON.stringify({ prod: { adapter: "e2b" } }));
    await chmod(loose, 0o644);
    const looseRun = await withCapturedWarnings(() => resolveFleet("prod", loose));
    assert.deepEqual(looseRun.warnings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
