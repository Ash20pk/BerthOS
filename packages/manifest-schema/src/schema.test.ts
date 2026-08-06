import { test } from "node:test";
import assert from "node:assert/strict";
import { BerthManifestSchema } from "./schema.js";
import { matchesCapability, parseCapability } from "./capability.js";

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
