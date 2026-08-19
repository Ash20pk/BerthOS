import { test } from "node:test";
import assert from "node:assert/strict";
import type { BerthManifest } from "@berth/manifest-schema";
import { explainAppError, enforcementFromContainerLogs } from "./capability-errors.js";

const manifest = {
  schemaVersion: 1,
  name: "filesystem",
  version: "0.1.0",
  capabilities: ["filesystem:read:/workspace", "filesystem:write:/workspace"],
  exports: [],
} as unknown as BerthManifest;

function ctx(overrides: Partial<Parameters<typeof explainAppError>[1]> = {}) {
  return {
    appName: "filesystem",
    manifest,
    manifestPath: "apps/filesystem/berth.yml",
    enforcement: "enforced" as const,
    ...overrides,
  };
}

test("a write outside every allowed prefix says no manifest line can grant it", () => {
  const out = explainAppError("EACCES: permission denied, open '/etc/berth-should-not-exist.txt'", ctx());
  assert.match(out, /BERTH CAPABILITY DENIAL/);
  assert.match(out, /denied: open\(2\) on \/etc\/berth-should-not-exist\.txt/);
  assert.match(out, /denied-by: the kernel/);
  assert.match(out, /fix: none available/);
  // The one thing this must never print: a fix line the schema rejects.
  assert.doesNotMatch(out, /filesystem:write:\/etc/);
  assert.match(out, /\/workspace, \/context, \/tmp, \/app/);
});

test("a write under an allowed but undeclared prefix names the exact line and the restart requirement", () => {
  const out = explainAppError("EACCES: permission denied, mkdir '/tmp/scratch/run-1'", ctx());
  assert.match(out, /- filesystem:write:\/tmp\/scratch/);
  assert.match(out, /apps\/filesystem\/berth\.yml/);
  assert.match(out, /cannot be widened on a running process/);
  assert.match(out, /declared: filesystem:read:\/workspace, filesystem:write:\/workspace/);
});

test("an ambiguous syscall offers both actions and says why, instead of guessing one", () => {
  const out = explainAppError("EACCES: permission denied, open '/context/notes/a.md'", ctx());
  assert.match(out, /- filesystem:write:\/context\/notes/);
  assert.match(out, /- filesystem:read:\/context\/notes/);
  assert.match(out, /used for both reading and writing/);
});

test("a denial on an already-declared path does not suggest another manifest line", () => {
  const out = explainAppError("EACCES: permission denied, mkdir '/workspace/data'", ctx());
  assert.match(out, /fix: not a missing declaration/);
  assert.match(out, /per-app-uid-design/);
  assert.doesNotMatch(out, /- filesystem:write:/);
});

test("EROFS is attributed to the read-only mount, not to capabilities", () => {
  const out = explainAppError("EROFS: read-only file system, open '/workspace/apps/filesystem/berth.yml'", ctx());
  assert.match(out, /VFS, not the capability policy/);
  assert.match(out, /Adding a capability line will NOT change this/);
  assert.doesNotMatch(out, /- filesystem:/);
});

test("an unenforced host is not allowed to present a denial as kernel enforcement", () => {
  const out = explainAppError("EACCES: permission denied, mkdir '/tmp/x/y'", ctx({ enforcement: "not-enforced" }));
  assert.match(out, /denied-by: NOT the Landlock policy/);
  assert.match(out, /berth doctor/);
});

test("unknown enforcement says it could not tell rather than claiming either answer", () => {
  const out = explainAppError("EACCES: permission denied, mkdir '/tmp/x/y'", ctx({ enforcement: "unknown" }));
  assert.match(out, /denied-by: unknown/);
  assert.doesNotMatch(out, /denied-by: the kernel —/);
});

test("a network failure in an app with no network capability explains the DNS symptom too", () => {
  const out = explainAppError("connect ECONNREFUSED 127.0.0.1:8090", ctx());
  assert.match(out, /BERTH CAPABILITY DENIAL \(network\)/);
  assert.match(out, /no network capability at all/);
  assert.match(out, /network:connect:8090/);
});

test("an ordinary application error is passed through untouched", () => {
  const raw = "Cannot read properties of undefined (reading 'title')";
  assert.equal(explainAppError(raw, ctx()), raw);
  const validation = 'invalid_type at "path": expected string, received number';
  assert.equal(explainAppError(validation, ctx()), validation);
});

test("ENOENT is not dressed up as a capability problem", () => {
  const raw = "ENOENT: no such file or directory, open '/workspace/missing.txt'";
  assert.equal(explainAppError(raw, ctx()), raw);
});

test("enforcement status is read from agent-init's own boot statement", () => {
  assert.equal(enforcementFromContainerLogs('{"source":"agent-init","ruleset":"FullyEnforced","timestamp":1}'), "enforced");
  assert.equal(enforcementFromContainerLogs('{"ruleset":"PartiallyEnforced"}'), "partially-enforced");
  assert.equal(enforcementFromContainerLogs('{"ruleset":"NotEnforced"}'), "not-enforced");
  assert.equal(enforcementFromContainerLogs('[agent-init] NOT RESTRICTED "filesystem" — this kernel did not apply'), "not-enforced");
  assert.equal(enforcementFromContainerLogs('[agent-init] restricted "filesystem" (FullyEnforced) — write access'), "enforced");
  assert.equal(enforcementFromContainerLogs("[berth:runtime] filesystem ready"), "unknown");
});
