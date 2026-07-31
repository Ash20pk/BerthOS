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

test("matchesCapability handles glob scopes", () => {
  assert.equal(matchesCapability("browser:navigate:*.github.com", "browser:navigate:api.github.com"), true);
  assert.equal(matchesCapability("browser:navigate:*.github.com", "browser:navigate:example.com"), false);
  assert.equal(matchesCapability("github:read:repos", "github:write:repos"), false);
});

test("parseCapability splits namespace/action/scope", () => {
  const parsed = parseCapability("filesystem:read:/workspace");
  assert.deepEqual(parsed, { namespace: "filesystem", action: "read", scope: "/workspace" });
});
