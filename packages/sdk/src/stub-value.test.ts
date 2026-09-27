import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { stubValue } from "./stub-value.js";

test("zod 4 schemas get typed stubs, not null", () => {
  assert.equal(stubValue(z.string()), "berth-test-stub");
  assert.equal(stubValue(z.number()), 1);
  assert.equal(stubValue(z.boolean()), true);
  assert.deepEqual(stubValue(z.array(z.string())), []);
  assert.equal(stubValue(z.string().optional()), undefined);
});

test("a zod 4 object stub parses against its own schema", () => {
  // The regression: every zod 4 schema fell through to null, so `berth test`
  // invoked each export with a null input and the handler rejected it.
  const schema = z.object({
    path: z.string(),
    size: z.number(),
    url: z.string(),
    tags: z.array(z.string()),
    note: z.string().optional(),
  });
  const stub = stubValue(schema);
  assert.deepEqual(stub, { path: "berth-test-stub", size: 1, url: "https://example.com", tags: [], note: undefined });
  assert.equal(schema.safeParse(stub).success, true);
});

test("zod 3's shape of a schema is still understood", () => {
  // zod 3 names the kind in _def.typeName and exposes the shape as a function.
  const zod3 = (typeName: string, extra: Record<string, unknown> = {}) => ({ _def: { typeName, ...extra } });
  const obj = zod3("ZodObject", { shape: () => ({ selector: zod3("ZodString"), n: zod3("ZodNumber") }) });
  assert.deepEqual(stubValue(obj), { selector: "body", n: 1 });
});

test("an unknown kind is null", () => {
  assert.equal(stubValue(z.date()), null);
  assert.equal(stubValue(undefined), null);
});
