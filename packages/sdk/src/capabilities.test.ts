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
