import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile, resolveEnvFlags } from "./env-args.js";

test("parseEnvFile reads dotenv lines", () => {
  assert.deepEqual(
    parseEnvFile(`# a comment\n\nGITHUB_TOKEN=ghp_abc\nexport REPO="owner/name"\nQUOTED='a b # not a comment'\nTRAILING=value # comment\nEMPTY=\n`),
    { GITHUB_TOKEN: "ghp_abc", REPO: "owner/name", QUOTED: "a b # not a comment", TRAILING: "value", EMPTY: "" },
  );
});

test("parseEnvFile names the line it can't read, without echoing a value elsewhere", () => {
  assert.throws(() => parseEnvFile("OK=1\nthis is not a pair\n"), /line 2/);
  assert.throws(() => parseEnvFile("1BAD=x\n"), /line 1/);
});

test("--env NAME takes the value from this shell; --env NAME=value is explicit; both beat the file", () => {
  const env = resolveEnvFlags(["TOKEN", "REPO=owner/name"], { TOKEN: "from-file", OTHER: "kept" }, { TOKEN: "from-shell" });
  assert.deepEqual(env, { TOKEN: "from-shell", REPO: "owner/name", OTHER: "kept" });
});

test("--env NAME that isn't set, or isn't a name, is an error", () => {
  assert.throws(() => resolveEnvFlags(["MISSING"], {}, {}), /isn't set in this shell/);
  assert.throws(() => resolveEnvFlags(["bad-name=x"], {}, {}), /isn't a valid variable name/);
});
