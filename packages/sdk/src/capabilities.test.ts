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
 * The policy file is the authority: its declaredCapabilities is the list
 * that was compiled into the enforced policy, and agent-init/the brokers
 * enforce against it, so requestCapability() must answer from it rather than
 * from berth.yml when both exist. Simulated by writing a capability-policy.json
 * whose declaredCapabilities differs from berth.yml.
 */
test("requestCapability answers from the compiled policy file, not berth.yml, when one exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "berth-capabilities-test-"));
  const manifestPath = join(dir, "berth.yml");
  await writeFile(manifestPath, ["name: test-app", "version: 1.0.0", "capabilities:", "  - filesystem:write:/workspace"].join("\n"));

  const policyPath = join(dir, "capability-policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      appName: "test-app",
      // berth.yml above never declares github:read:repos; only the policy
      // file does.
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

  const fromPolicy = await requestCapability("test-app", "github:read:repos");
  assert.equal(fromPolicy.granted, true, "the compiled policy file must be what requestCapability answers from");

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

test("a grant carries no token — capability tokens were removed", async () => {
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
  assert.equal("verifyCapabilityToken" in sdk, false, "@berthos/sdk should no longer export verifyCapabilityToken");
});
