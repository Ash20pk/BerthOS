import { test } from "node:test";
import assert from "node:assert/strict";
import { BerthManifestSchema } from "./schema.js";
import { matchesCapability, parseCapability, capabilityIssue, filesystemScopeIssue } from "./capability.js";

test("accepts the PRD's github-assistant manifest", () => {
  const result = BerthManifestSchema.safeParse({
    name: "github-assistant",
    version: "1.0.0",
    capabilities: ["github:read:repos", "github:write:issues", "filesystem:read:/workspace", "browser:navigate:*.github.com"],
    exports: [
      { name: "create_issue", input: { title: "string", body: "string" } },
      { name: "get_repo_summary", input: { repo: "string" }, output: { summary: "string", open_issues: "number" } },
    ],
    on_install: ["pip install -r requirements.txt"],
    on_agent_ready: ["register_with_context_bus"],
  });
  assert.equal(result.success, true);
});

test("rejects a malformed capability string", () => {
  const result = BerthManifestSchema.safeParse({
    name: "bad-app",
    version: "1.0.0",
    capabilities: ["not-a-capability"],
  });
  assert.equal(result.success, false);
});

// on_install entries become lines in a generated build script (REMEDIATION
// 1.5). The script file is what removes the Dockerfile-injection surface, so
// these two checks are only about an entry being a command at all — a
// multi-line command is legal and stays legal, which the third case pins so a
// future "harden this" change doesn't quietly break a working manifest.
test("rejects an empty on_install command", () => {
  const result = BerthManifestSchema.safeParse({ name: "app", version: "1.0.0", on_install: ["echo ok", "   "] });
  assert.equal(result.success, false);
  assert.deepEqual(result.error?.issues[0]?.path, ["on_install", 1]);
});

test("rejects an on_install command containing a NUL byte", () => {
  const result = BerthManifestSchema.safeParse({ name: "app", version: "1.0.0", on_install: ["echo \0 oops"] });
  assert.equal(result.success, false);
});

test("accepts a multi-line on_install command", () => {
  const result = BerthManifestSchema.safeParse({
    name: "app",
    version: "1.0.0",
    on_install: ["set -x\napk add --no-cache jq"],
  });
  assert.equal(result.success, true);
});

test("rejects a non-semver version", () => {
  const result = BerthManifestSchema.safeParse({ name: "app", version: "v1" });
  assert.equal(result.success, false);
});

test("defaults optional arrays to empty", () => {
  const result = BerthManifestSchema.parse({ name: "app", version: "1.0.0" });
  assert.deepEqual(result.capabilities, []);
  assert.deepEqual(result.exports, []);
});

test("expose defaults to true for browser/terminal and false for preview when omitted", () => {
  const result = BerthManifestSchema.parse({ name: "app", version: "1.0.0" });
  assert.deepEqual(result.expose, { browser: true, terminal: true, preview: false });
});

test("expose lets an author disable just one of browser/terminal", () => {
  const result = BerthManifestSchema.parse({
    name: "app",
    version: "1.0.0",
    expose: { browser: false },
  });
  assert.deepEqual(result.expose, { browser: false, terminal: true, preview: false });
});

test("expose lets an author opt in to a deploy-target preview URL", () => {
  const result = BerthManifestSchema.parse({
    name: "app",
    version: "1.0.0",
    expose: { preview: true },
  });
  assert.deepEqual(result.expose, { browser: true, terminal: true, preview: true });
});

test("governs defaults to false, governance.exempt defaults to false", () => {
  const result = BerthManifestSchema.parse({ name: "app", version: "1.0.0" });
  assert.equal(result.governs, false);
  assert.deepEqual(result.governance, { exempt: false });
});

test("governs: true requires an evaluate_action export", () => {
  const result = BerthManifestSchema.safeParse({
    name: "governance-app",
    version: "1.0.0",
    governs: true,
    exports: [{ name: "get_history", output: { events: "array" } }],
  });
  assert.equal(result.success, false);
});

test("governs: true with evaluate_action export is accepted", () => {
  const result = BerthManifestSchema.safeParse({
    name: "governance-app",
    version: "1.0.0",
    governs: true,
    exports: [{ name: "evaluate_action", input: { app: "string", export: "string", input: "object" }, output: { allowed: "boolean", reason: "string" } }],
  });
  assert.equal(result.success, true);
});

test("an app can opt out of governance", () => {
  const result = BerthManifestSchema.parse({
    name: "app",
    version: "1.0.0",
    governance: { exempt: true },
  });
  assert.deepEqual(result.governance, { exempt: true });
});

test("resources defaults to empty (no limits declared)", () => {
  const result = BerthManifestSchema.parse({ name: "app", version: "1.0.0" });
  assert.deepEqual(result.resources, {});
});

test("resources accepts fractional cpu, integer memory_mb and gpu count", () => {
  const result = BerthManifestSchema.parse({
    name: "app",
    version: "1.0.0",
    resources: { cpu: 0.5, memory_mb: 512, gpu: 1 },
  });
  assert.deepEqual(result.resources, { cpu: 0.5, memory_mb: 512, gpu: 1 });
});

test("resources rejects a non-positive cpu/memory_mb/gpu", () => {
  assert.equal(BerthManifestSchema.safeParse({ name: "app", version: "1.0.0", resources: { cpu: 0 } }).success, false);
  assert.equal(BerthManifestSchema.safeParse({ name: "app", version: "1.0.0", resources: { memory_mb: -1 } }).success, false);
  assert.equal(BerthManifestSchema.safeParse({ name: "app", version: "1.0.0", resources: { gpu: 1.5 } }).success, false);
});

test("matchesCapability handles glob scopes", () => {
  assert.equal(matchesCapability("browser:navigate:*.github.com", "browser:navigate:api.github.com"), true);
  assert.equal(matchesCapability("browser:navigate:*.github.com", "browser:navigate:example.com"), false);
  assert.equal(matchesCapability("github:read:repos", "github:write:repos"), false);
});

test("parseCapability splits namespace/action/scope", () => {
  const parsed = parseCapability("filesystem:read:/workspace");
  assert.deepEqual(parsed, { namespace: "filesystem", action: "read", scope: "/workspace" });
});

// filesystem: scopes are the one capability scope that becomes a real path
// agent-init creates as uid 0 (with CAP_SYS_ADMIN, and in `berth dev` on the
// developer's host through the bind mount) before Landlock is applied — so
// they're validated here, at manifest-load time, where the error can name a
// line in berth.yml. See REMEDIATION.md item 1.12.
function capabilityResult(capability: string) {
  return BerthManifestSchema.safeParse({ name: "app", version: "1.0.0", capabilities: [capability] });
}

test("rejects filesystem:write:/ — the whole container filesystem", () => {
  const result = capabilityResult("filesystem:write:/");
  assert.equal(result.success, false);
  assert.match(result.error!.issues[0]!.message, /entire container filesystem/);
  assert.deepEqual(result.error!.issues[0]!.path, ["capabilities", 0]);
});

test("rejects filesystem scopes outside the allowed prefixes", () => {
  for (const scope of ["/etc", "/etc/passwd", "/root", "/usr/local/bin", "/workspacex", "/tmpfoo"]) {
    assert.equal(capabilityResult(`filesystem:write:${scope}`).success, false, `filesystem:write:${scope} should be rejected`);
    assert.equal(capabilityResult(`filesystem:read:${scope}`).success, false, `filesystem:read:${scope} should be rejected`);
  }
});

test("rejects a filesystem scope that isn't an absolute canonical path", () => {
  // "*" is the one worth spelling out: it used to compile into a Landlock
  // grant on a literal directory named "*", which agent-init then created.
  for (const scope of ["*", "workspace", "/workspace/../etc", "/workspace/./x", "/workspace//x", "/workspace/", "/workspace/*/src"]) {
    assert.equal(capabilityResult(`filesystem:write:${scope}`).success, false, `filesystem:write:${scope} should be rejected`);
  }
});

test("accepts the filesystem scopes first-party apps actually declare", () => {
  for (const scope of ["/workspace", "/workspace/*", "/workspace/packages/docker-orchestrator/test/fixtures/boundary-app-a", "/context", "/tmp/my-app", "/app"]) {
    assert.equal(capabilityResult(`filesystem:write:${scope}`).success, true, `filesystem:write:${scope} should be accepted`);
    assert.equal(capabilityResult(`filesystem:read:${scope}`).success, true, `filesystem:read:${scope} should be accepted`);
  }
});

test("leaves non-filesystem scopes alone — they're hosts, ports and peer names, not paths", () => {
  for (const capability of ["browser:navigate:*", "browser:navigate:*.github.com", "github:read:repos", "network:connect:*", "network:peer:*", "terminal:attach:*"]) {
    assert.equal(capabilityResult(capability).success, true, `${capability} should be accepted`);
  }
});

test("filesystemScopeIssue is exported for callers that validate capabilities outside a manifest", () => {
  // @berth/sdk's generate-capability-policy.ts uses this on grants-server
  // strings, which never pass through BerthManifestSchema at all.
  assert.equal(filesystemScopeIssue("/workspace/notes"), undefined);
  assert.ok(filesystemScopeIssue("/etc"));
  assert.ok(capabilityIssue("filesystem:write:/etc"));
  assert.equal(capabilityIssue("github:read:repos"), undefined);
});
