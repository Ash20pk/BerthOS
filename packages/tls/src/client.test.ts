import { strict as assert } from "node:assert";
import { test } from "node:test";
import { warnIfCredentialOverPlaintext } from "./client.js";

function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (msg: unknown) => void lines.push(String(msg));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

test("warns about a credential sent over plain HTTP to a remote host", () => {
  const warnings = captureStderr(() => warnIfCredentialOverPlaintext("http://grants.internal:4874", "an operator token"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /operator token/);
  assert.match(warnings[0]!, /plain HTTP/);
});

test("stays quiet for loopback, where nothing crosses a network", () => {
  // Warning here would train people to ignore the warning that matters.
  for (const url of ["http://127.0.0.1:4874", "http://localhost:4874", "http://[::1]:4874"]) {
    assert.deepEqual(captureStderr(() => warnIfCredentialOverPlaintext(url)), [], url);
  }
});

test("stays quiet for https", () => {
  assert.deepEqual(captureStderr(() => warnIfCredentialOverPlaintext("https://grants.internal:4874")), []);
});

test("says nothing about an unparseable URL — that is the caller's error to report", () => {
  assert.deepEqual(captureStderr(() => warnIfCredentialOverPlaintext("not a url")), []);
});
