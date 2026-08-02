import { test } from "node:test";
import assert from "node:assert/strict";
import { BerthManifestSchema } from "@berth/manifest-schema";
import { declaresBrowserCapability, declaresTerminalCapability, needsBrowserPorts, needsTerminalPort } from "./container.js";

function manifest(capabilities: string[], expose?: { browser?: boolean; terminal?: boolean }) {
  return BerthManifestSchema.parse({ name: "app", version: "1.0.0", capabilities, expose });
}

test("needsBrowserPorts is true when browser:* is declared and expose.browser defaults true", () => {
  const m = manifest(["browser:navigate:*.github.com"]);
  assert.equal(declaresBrowserCapability(m), true);
  assert.equal(needsBrowserPorts(m), true);
});

test("needsBrowserPorts is false when expose.browser is explicitly disabled", () => {
  const m = manifest(["browser:navigate:*.github.com"], { browser: false });
  assert.equal(declaresBrowserCapability(m), true);
  assert.equal(needsBrowserPorts(m), false);
});

test("needsBrowserPorts is false when no browser:* capability is declared, regardless of expose", () => {
  const m = manifest(["filesystem:write:/workspace"], { browser: true });
  assert.equal(declaresBrowserCapability(m), false);
  assert.equal(needsBrowserPorts(m), false);
});

test("needsTerminalPort follows the same rule as needsBrowserPorts", () => {
  const exposed = manifest(["terminal:attach:*"]);
  const hidden = manifest(["terminal:attach:*"], { terminal: false });
  assert.equal(needsTerminalPort(exposed), true);
  assert.equal(needsTerminalPort(hidden), false);
  assert.equal(declaresTerminalCapability(hidden), true);
});
