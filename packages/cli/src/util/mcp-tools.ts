import { z } from "zod";
import type { BerthManifest, ExportSpecType, JsonPrimitiveTypeName } from "@berth/manifest-schema";

/**
 * Maps one IOSpec field's primitive type name to a Zod schema, so a
 * manifest export's flat input map becomes the Zod raw shape
 * @modelcontextprotocol/sdk's registerTool() expects. IOSpec is
 * intentionally flat (no nesting) — object/array fields are left
 * unconstrained beyond their JS-level shape, matching this manifest
 * grammar's own simplicity.
 */
function zodFor(type: JsonPrimitiveTypeName): z.ZodTypeAny {
  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "object":
      return z.record(z.string(), z.unknown());
    case "array":
      return z.array(z.unknown());
  }
}

/** A manifest export's `input` map, as the raw Zod shape MCP's registerTool() needs — {} (no args) when the export declares none. */
export function inputShapeFor(exportSpec: ExportSpecType): Record<string, z.ZodTypeAny> {
  const input = exportSpec.input ?? {};
  return Object.fromEntries(Object.entries(input).map(([field, type]) => [field, zodFor(type)]));
}

/** Every export declared in a manifest, as {name, description, inputShape} ready to hand to registerTool(). */
export function mcpToolsFor(manifest: BerthManifest): Array<{ name: string; description: string; inputShape: Record<string, z.ZodTypeAny> }> {
  return manifest.exports.map((exportSpec) => ({
    name: exportSpec.name,
    description: `Berth resident app export "${exportSpec.name}" (from ${manifest.name}'s berth.yml)`,
    inputShape: inputShapeFor(exportSpec),
  }));
}
