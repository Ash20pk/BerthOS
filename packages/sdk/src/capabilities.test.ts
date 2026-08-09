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
  // Fresh import per test run so the module-level manifest cache doesn't leak across assertions.
  const { requestCapability } = await import(`./capabilities.js?t=${Date.now()}`);

  const granted = await requestCapability("test-app", "filesystem:write:/workspace");
  assert.equal(granted.granted, true);

  const grantedGlob = await requestCapability("test-app", "browser:navigate:api.github.com");
  assert.equal(grantedGlob.granted, true);

  const denied = await requestCapability("test-app", "filesystem:write:/etc");
  assert.equal(denied.granted, false);
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
  const { requestCapability } = await import(`./capabilities.js?t=${Date.now()}`);

  const granted = await requestCapability("test-app", "filesystem:write:/workspace");
  assert.equal(granted.granted, true);

  delete process.env.BERTH_CAPABILITY_POLICY;
});

test("a grant carries no token — REMEDIATION.md 1.10 removed them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-capabilities-test-"));
  const manifestPath = join(dir, "berth.yml");
  await writeFile(manifestPath, ["name: test-app", "version: 1.0.0", "capabilities:", "  - filesystem:write:/workspace"].join("\n"));

  process.env.BERTH_MANIFEST_PATH = manifestPath;
  const { requestCapability } = await import(`./capabilities.js?t=${Date.now()}`);

  // This test replaces one that asserted the HMAC verified correctly. It did
  // — that was never the problem. The problem was that the signing secret sat
  // in the environment of the app the token was meant to constrain, and that
  // nothing anywhere called the verifier. Asserting the absence keeps the API
  // from quietly growing a token back.
  const grant = (await requestCapability("test-app", "filesystem:write:/workspace")) as Record<string, unknown>;
  assert.equal(grant.granted, true);
  for (const gone of ["token", "issuedAt", "expiresAt"]) {
    assert.equal(gone in grant, false, `CapabilityGrant should no longer carry "${gone}"`);
  }

  const sdk = (await import(`./index.js?t=${Date.now()}`)) as Record<string, unknown>;
  assert.equal("verifyCapabilityToken" in sdk, false, "@berth/sdk should no longer export verifyCapabilityToken");
});
