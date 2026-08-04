import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { parseStructuredOutput, structuredOutputRepairPrompt, StructuredOutputError } from "./structured-output.js";

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
