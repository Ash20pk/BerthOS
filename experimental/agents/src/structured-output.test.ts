import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  parseStructuredOutput,
  structuredOutputRepairPrompt,
  StructuredOutputError,
  formatToolInputError,
} from "./structured-output.js";

const schema = z.object({ name: z.string(), age: z.number() });

test("parseStructuredOutput() succeeds on valid JSON matching the schema", () => {
  const result = parseStructuredOutput('{"name": "ash", "age": 5}', schema);
  assert.deepEqual(result, { success: true, data: { name: "ash", age: 5 } });
});

test("parseStructuredOutput() fails with a clear error on text that isn't JSON at all", () => {
  const result = parseStructuredOutput("not json at all", schema);
  assert.equal(result.success, false);
  assert.match((result as { error: string }).error, /not valid JSON/);
});

test("parseStructuredOutput() fails with per-field issues on valid JSON that doesn't match the schema", () => {
  const result = parseStructuredOutput('{"name": "ash", "age": "not a number"}', schema);
  assert.equal(result.success, false);
  assert.match((result as { error: string }).error, /age/);
});

test("parseStructuredOutput() reports a missing required field by path", () => {
  const result = parseStructuredOutput('{"name": "ash"}', schema);
  assert.equal(result.success, false);
  assert.match((result as { error: string }).error, /age/);
});

test("structuredOutputRepairPrompt() includes the error and asks for corrected JSON only", () => {
  const prompt = structuredOutputRepairPrompt("age: expected number, got string");
  assert.match(prompt, /age: expected number, got string/);
  assert.match(prompt, /ONLY corrected JSON/);
});

test("StructuredOutputError carries the model's last raw (invalid) text", () => {
  const err = new StructuredOutputError("failed after 2 attempts", "not json");
  assert.equal(err.rawText, "not json");
  assert.equal(err.name, "StructuredOutputError");
  assert.ok(err instanceof Error);
});

test("formatToolInputError() reformats a real ZodError's default JSON-array message into the compact path: message shape", () => {
  const toolInputSchema = z.object({ path: z.string(), content: z.string() });
  let rawMessage = "";
  try {
    toolInputSchema.parse({ path: 123 });
  } catch (err) {
    rawMessage = err instanceof Error ? err.message : String(err);
  }

  const formatted = formatToolInputError(rawMessage);

  assert.match(formatted, /^path:/, "reformatted into the same leading `path:` shape parseStructuredOutput() produces");
  assert.match(formatted, /content:/, "both failing fields must survive, not just the first");
  assert.ok(!formatted.trimStart().startsWith("["), "must no longer look like the raw JSON array");
});

test("formatToolInputError() passes a plain, non-Zod error message through unchanged", () => {
  assert.equal(formatToolInputError("connection refused"), "connection refused");
});

test("formatToolInputError() passes non-JSON text through unchanged", () => {
  assert.equal(formatToolInputError("no such tool \"bogus\""), 'no such tool "bogus"');
});

test("formatToolInputError() passes valid-JSON-but-not-Zod-issues-shaped text through unchanged", () => {
  assert.equal(formatToolInputError('{"code": "ENOENT"}'), '{"code": "ENOENT"}');
  assert.equal(formatToolInputError("[1, 2, 3]"), "[1, 2, 3]", "a JSON array that isn't issue-shaped must not be mistaken for one");
});
