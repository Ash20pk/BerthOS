import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile, resolveEnvFlags, undeclaredEnvNames } from "./env-args.js";

test("parseEnvFile reads dotenv lines", () => {
  assert.deepEqual(
    parseEnvFile(`# a comment\n\nGITHUB_TOKEN=ghp_abc\nexport REPO="owner/name"\nQUOTED='a b # not a comment'\nTRAILING=value # comment\nEMPTY=\n`),
    { GITHUB_TOKEN: "ghp_abc", REPO: "owner/name", QUOTED: "a b # not a comment", TRAILING: "value", EMPTY: "" },
  );
});

test("parseEnvFile drops a comment after a quoted value, and keeps the quotes out", () => {
  assert.deepEqual(parseEnvFile(`API_KEY="abc" # prod key\nOTHER='x y'   # note\nBARE="v"\n`), { API_KEY: "abc", OTHER: "x y", BARE: "v" });
});

test("parseEnvFile reads a multi-line quoted value, such as a PEM key", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC==\n-----END PRIVATE KEY-----";
  assert.deepEqual(parseEnvFile(`BEFORE=1\nTLS_KEY="${pem}"\nAFTER=2\n`), { BEFORE: "1", TLS_KEY: pem, AFTER: "2" });
  assert.deepEqual(parseEnvFile(`K='line1\nline2'\n`), { K: "line1\nline2" });
});

test("parseEnvFile expands escapes in double quotes only", () => {
  assert.deepEqual(parseEnvFile(`D="a\\nb \\"q\\" \\\\"\nS='a\\nb'\n`), { D: 'a\nb "q" \\', S: "a\\nb" });
});

test("parseEnvFile errors name the line and at most a valid name, never a value", () => {
  const secret = "ghp_S3CRETvalue123";
  const cases: [string, RegExp][] = [
    [`OK=1\n${secret}\n`, /^line 2 /],
    [`GITHUB-TOKEN=${secret}\n`, /^line 1:/],
    [`1BAD=${secret}\n`, /^line 1:/],
    // An unclosed quote: the lines after it, a PEM body say, are never echoed.
    [`TLS_KEY="-----BEGIN\n${secret}==\n`, /^line 1: TLS_KEY's/],
    [`API_KEY="${secret}" trailing\n`, /^line 1: API_KEY has text after/],
    // A base64 fragment with a "=" in it must not be echoed as if it were a name.
    [`${secret}+/x=\n`, /^line 1:/],
  ];
  for (const [text, expected] of cases) {
    assert.throws(
      () => parseEnvFile(text),
      (err: Error) => {
        assert.match(err.message, expected);
        assert.ok(!err.message.includes(secret), `error echoed the value: ${err.message}`);
        assert.ok(!err.message.includes("S3CRET"), `error echoed part of the value: ${err.message}`);
        return true;
      },
    );
  }
});

test("--env NAME takes the value from this shell; --env NAME=value is explicit; both beat the file", () => {
  const env = resolveEnvFlags(["TOKEN", "REPO=owner/name"], { TOKEN: "from-file", OTHER: "kept" }, { TOKEN: "from-shell" });
  assert.deepEqual(env, { TOKEN: "from-shell", REPO: "owner/name", OTHER: "kept" });
});

test("--env NAME that isn't set, or isn't a name, is an error that never echoes a value", () => {
  assert.throws(() => resolveEnvFlags(["OK=1", "MISSING"], {}, {}), /--env #2: MISSING isn't set in this shell/);
  // A pasted token is often a valid name; one that doesn't look like a
  // conventional variable name is referred to by position only.
  assert.throws(
    () => resolveEnvFlags(["ghp_S3CRETvalue123"], {}, {}),
    (err: Error) => {
      assert.match(err.message, /^--env #1: that name isn't set in this shell/);
      assert.ok(!err.message.includes("S3CRET"), err.message);
      return true;
    },
  );
  assert.throws(
    () => resolveEnvFlags(["OK=1", "GH-TOKEN=ghp_SECRET"], {}, {}),
    (err: Error) => {
      assert.match(err.message, /^--env #2: .*isn't a valid variable name/);
      assert.ok(!err.message.includes("ghp_SECRET"), err.message);
      return true;
    },
  );
});

test("undeclaredEnvNames lists the names no loaded app declares under secrets:", () => {
  const apps = [{ manifest: { secrets: ["GITHUB_TOKEN"] } }, { manifest: { secrets: [] } }, { manifest: {} }];
  assert.deepEqual(undeclaredEnvNames({ GITHUB_TOKEN: "x", GITHUB_REPO: "o/n", OPENAI_API_KEY: "y" }, apps), ["GITHUB_REPO", "OPENAI_API_KEY"]);
  assert.deepEqual(undeclaredEnvNames({}, apps), []);
});
