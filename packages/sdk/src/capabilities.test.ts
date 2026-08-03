import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("requestCapability grants declared capabilities and denies undeclared ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-capabilities-test-"));
  const manifestPath = join(dir, "berth.yml");
  await writeFile(
    manifestPath,
    [
      "name: test-app",
      "version: 1.0.0",
      "capabilities:",
      "  - filesystem:write:/workspace",
      "  - browser:navigate:*.github.com",
    ].join("\n"),
  );

  process.env.BERTH_MANIFEST_PATH = manifestPath;
  process.env.BERTH_TOKEN_SECRET = "test-secret";
  // Fresh import per test run so the module-level manifest cache doesn't leak across assertions.
  const { requestCapability, verifyCapabilityToken } = await import(`./capabilities.js?t=${Date.now()}`);

  const granted = await requestCapability("test-app", "filesystem:write:/workspace");
  assert.equal(granted.granted, true);
  assert.ok(granted.token);
  assert.ok(granted.expiresAt);

  const grantedGlob = await requestCapability("test-app", "browser:navigate:api.github.com");
  assert.equal(grantedGlob.granted, true);

  const denied = await requestCapability("test-app", "filesystem:write:/etc");
  assert.equal(denied.granted, false);
  assert.equal(denied.token, null);
  assert.equal(denied.expiresAt, null);
});

/**
 * Regression test for the bug: requestCapability() used to read only
 * berth.yml's static `capabilities:` list, so it could never see a
 * capability approved via `berth grants approve` after the fact — even
 * though generate-capability-policy.ts's capability-policy.json (which
 * agent-init/the brokers already enforce against) merges exactly that
 * approval in. Simulates "approve a grant, restart the container" by
 * writing a capability-policy.json whose declaredCapabilities includes a
 * capability berth.yml itself never declared.
 */
test("requestCapability sees a capability approved via the grants-server policy file, not just berth.yml", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-capabilities-test-"));
  const manifestPath = join(dir, "berth.yml");
  await writeFile(manifestPath, ["name: test-app", "version: 1.0.0", "capabilities:", "  - filesystem:write:/workspace"].join("\n"));

  const policyPath = join(dir, "capability-policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      appName: "test-app",
      // filesystem:write:/workspace (static) plus github:read:repos, approved
      // via `berth grants approve` after the fact and merged in by
      // generate-capability-policy.ts's main() — berth.yml above never
      // declares this one.
      declaredCapabilities: ["filesystem:write:/workspace", "github:read:repos"],
      writePaths: ["/workspace"],
      readPaths: [],
      networkPorts: [],
      networkUnrestricted: false,
      meshPeers: [],
    }),
  );

  process.env.BERTH_MANIFEST_PATH = manifestPath;
  process.env.BERTH_CAPABILITY_POLICY = policyPath;
  process.env.BERTH_TOKEN_SECRET = "test-secret";
  const { requestCapability } = await import(`./capabilities.js?t=${Date.now()}`);

  const approvedViaGrant = await requestCapability("test-app", "github:read:repos");
  assert.equal(approvedViaGrant.granted, true, "a grants-approved capability must be seen, not just berth.yml's static list");

  const stillUndeclared = await requestCapability("test-app", "github:write:repos");
  assert.equal(stillUndeclared.granted, false);

  delete process.env.BERTH_CAPABILITY_POLICY;
});

test("requestCapability falls back to berth.yml when no policy file exists (e.g. outside a container)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-capabilities-test-"));
  const manifestPath = join(dir, "berth.yml");
  await writeFile(manifestPath, ["name: test-app", "version: 1.0.0", "capabilities:", "  - filesystem:write:/workspace"].join("\n"));

  process.env.BERTH_MANIFEST_PATH = manifestPath;
  process.env.BERTH_CAPABILITY_POLICY = join(dir, "does-not-exist.json");
  process.env.BERTH_TOKEN_SECRET = "test-secret";
  const { requestCapability } = await import(`./capabilities.js?t=${Date.now()}`);

  const granted = await requestCapability("test-app", "filesystem:write:/workspace");
  assert.equal(granted.granted, true);

  delete process.env.BERTH_CAPABILITY_POLICY;
});

test("verifyCapabilityToken accepts a real token and rejects tampering/expiry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-capabilities-test-"));
  const manifestPath = join(dir, "berth.yml");
  await writeFile(manifestPath, ["name: test-app", "version: 1.0.0", "capabilities:", "  - filesystem:write:/workspace"].join("\n"));

  process.env.BERTH_MANIFEST_PATH = manifestPath;
  process.env.BERTH_TOKEN_SECRET = "test-secret";
  const { requestCapability, verifyCapabilityToken } = await import(`./capabilities.js?t=${Date.now()}`);

  const grant = await requestCapability("test-app", "filesystem:write:/workspace");
  assert.ok(grant.token && grant.issuedAt && grant.expiresAt);

  assert.equal(verifyCapabilityToken("test-app", "filesystem:write:/workspace", grant.issuedAt, grant.expiresAt, grant.token), true);
  assert.equal(verifyCapabilityToken("test-app", "filesystem:write:/other", grant.issuedAt, grant.expiresAt, grant.token), false);
  assert.equal(verifyCapabilityToken("test-app", "filesystem:write:/workspace", grant.issuedAt, grant.expiresAt, "0".repeat(64)), false);

  const alreadyExpired = new Date(Date.now() - 60_000).toISOString();
  assert.equal(
    verifyCapabilityToken("test-app", "filesystem:write:/workspace", grant.issuedAt, alreadyExpired, grant.token),
    false,
  );
});
