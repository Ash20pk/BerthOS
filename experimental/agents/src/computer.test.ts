import { test } from "node:test";
import assert from "node:assert/strict";
import { computerEnforcementEnv } from "./computer.js";

test("Computer.boot() requires per-app cgroups by default, as it requires Landlock", () => {
  assert.deepEqual(computerEnforcementEnv(false), { BERTH_REQUIRE_APP_CGROUPS: "1" });
  assert.deepEqual(computerEnforcementEnv(false, { FOO: "bar" }), { BERTH_REQUIRE_APP_CGROUPS: "1", FOO: "bar" });
});

test("a caller's env can relax per-app cgroups alone, keeping Landlock strict", () => {
  const env = computerEnforcementEnv(false, { BERTH_REQUIRE_APP_CGROUPS: "0" });
  assert.equal(env.BERTH_REQUIRE_APP_CGROUPS, "0");
  assert.equal(env.BERTH_REQUIRE_ENFORCEMENT, undefined, "the production image's own BERTH_REQUIRE_ENFORCEMENT=1 stands");
});

test('enforcement: "warn" turns both off, whatever the caller passed', () => {
  assert.deepEqual(computerEnforcementEnv(true, { BERTH_REQUIRE_APP_CGROUPS: "1", FOO: "bar" }), {
    FOO: "bar",
    BERTH_REQUIRE_ENFORCEMENT: "0",
    BERTH_REQUIRE_APP_CGROUPS: "0",
  });
});
