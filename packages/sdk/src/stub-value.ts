// Schema-valid stub inputs for `berth test` (see check-exports.ts).
//
// Handles both zod majors an app might build its schemas with: zod 3 names a
// schema's kind in `_def.typeName` ("ZodString") and exposes an object's shape
// as a function, zod 4 names it in `_def.type` ("string") and exposes the
// shape as a plain object. Reading only the zod 3 fields made every zod 4
// schema fall through to `null`, so every export was invoked with a null input.

// Type-only stub generation (a random string satisfies z.string()) isn't
// always a *useful* stub — a field named "url" or "selector" needs a
// semantically valid value or a real handler (like browser-native's
// `page.goto`/`page.click`) will legitimately reject it. This is a plain
// field-name heuristic, not a schema feature — it only covers the common
// cases worth guessing at.
const FIELD_NAME_HINTS: Record<string, string> = {
  url: "https://example.com",
  selector: "body",
  email: "test@example.com",
};

/** A schema's kind in zod 4's lowercase vocabulary, from either major. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function schemaKind(zodType: any): string | undefined {
  const def = zodType?._def;
  if (!def) return undefined;
  if (typeof def.typeName === "string") return def.typeName.replace(/^Zod/, "").toLowerCase();
  return typeof def.type === "string" ? def.type : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function stubValue(zodType: any, fieldName?: string): unknown {
  switch (schemaKind(zodType)) {
    case "string":
      return (fieldName && FIELD_NAME_HINTS[fieldName]) ?? "berth-test-stub";
    case "number":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "enum":
      // Both majors expose the values as `.options`; the first is as valid as any.
      return zodType.options?.[0] ?? null;
    case "literal":
      return zodType._def.values?.[0] ?? zodType._def.value ?? null;
    case "object": {
      const def = zodType._def;
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      const obj: Record<string, unknown> = {};
      for (const key of Object.keys(shape ?? {})) obj[key] = stubValue(shape[key], key);
      return obj;
    }
    case "optional":
    case "nullable":
      return undefined;
    default:
      return null;
  }
}
