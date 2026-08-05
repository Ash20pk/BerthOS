import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOnlyExports } from "./mcp-tools.js";

test("parseOnlyExports returns every named export when all are declared", () => {
  const result = parseOnlyExports("read_file,write_file", ["read_file", "write_file", "list_files"]);
  assert.deepEqual(result.names, ["read_file", "write_file"]);
  assert.deepEqual(result.unknown, []);
});

test("parseOnlyExports trims whitespace around names", () => {
  const result = parseOnlyExports(" read_file , write_file ", ["read_file", "write_file"]);
  assert.deepEqual(result.names, ["read_file", "write_file"]);
});

test("parseOnlyExports reports names that aren't actually declared, instead of silently dropping them", () => {
  const result = parseOnlyExports("read_file,delete_everything", ["read_file", "write_file"]);
  assert.deepEqual(result.names, ["read_file", "delete_everything"]);
  assert.deepEqual(result.unknown, ["delete_everything"]);
});

test("parseOnlyExports drops empty entries from trailing/doubled commas", () => {
  const result = parseOnlyExports("read_file,,write_file,", ["read_file", "write_file"]);
  assert.deepEqual(result.names, ["read_file", "write_file"]);
  assert.deepEqual(result.unknown, []);
});

test("parseOnlyExports with a single export name and no commas", () => {
  const result = parseOnlyExports("read_file", ["read_file", "write_file"]);
  assert.deepEqual(result.names, ["read_file"]);
  assert.deepEqual(result.unknown, []);
});
