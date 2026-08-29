import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAgents, resetAgentsCache, isModuleNotFound, describeMissingFramework } from "./optional-agents.js";

/**
 * The point of the seam is that `@berth/cli` does not depend on
 * `@berth/agents` at runtime. In this workspace it IS installed (a
 * devDependency, for typechecking the three commands that use it), so the
 * happy path is testable directly and the missing-package path is tested by
 * driving the same error handling the loader has.
 */

test("loadAgents resolves the framework when it is installed", async () => {
  resetAgentsCache();
  const mod = await loadAgents("eval");
  assert.equal(typeof mod.runEvalSuite, "function");
  assert.equal(typeof mod.createAgentFromYaml, "function");
  assert.equal(typeof mod.createCrewFromYaml, "function");
  assert.equal(typeof mod.listEvalRuns, "function");
  assert.equal(typeof mod.recordEvalRun, "function");
});

test("loadAgents caches, so three lazy call sites in one command load once", async () => {
  resetAgentsCache();
  const first = await loadAgents("eval");
  const second = await loadAgents("eval");
  assert.equal(first, second, "the same module object must come back, not a second evaluation");
});

/**
 * The failure that matters: a published `@berth/cli` without the optional peer
 * installed must say what to install, not emit a module-resolution trace.
 * These call the loader's own exported classification and message, not a copy
 * of them, so drift between the two cannot pass.
 */
test("node's missing-package errors are classified as missing, on both module systems", () => {
  for (const code of ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]) {
    assert.equal(isModuleNotFound(Object.assign(new Error("Cannot find package"), { code })), true, code);
  }
});

test("a real failure inside the framework is not classified as missing", () => {
  // A broken build, a bad transitive dep, a syntax error. Telling someone to
  // reinstall a package that is already installed wastes the whole session.
  for (const code of ["ERR_PARSE_ERROR", "ERR_REQUIRE_ESM", undefined]) {
    assert.equal(isModuleNotFound(Object.assign(new Error("boom"), code ? { code } : {})), false, String(code));
  }
});

test("the missing-framework message names the command, the install, and why", () => {
  const msg = describeMissingFramework("agent run");
  assert.match(msg, /berth agent run/, "someone sees this after typing a command — it should name that command");
  assert.match(msg, /npm install @berth\/agents/, "the fix must be copy-pasteable");
  assert.match(msg, /does not depend on it/, "it should explain why it is not already there, or it reads as a packaging bug");
  assert.ok(!/ERR_MODULE_NOT_FOUND/.test(msg), "the errno is noise to someone who just needs to install a package");
});
