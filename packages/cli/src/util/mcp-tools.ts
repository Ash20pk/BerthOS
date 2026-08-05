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

/**
 * Parses `berth mcp --only`'s comma-separated export-name list against a
 * manifest's actual declared exports — real capability scoping for gap #26
 * ("MCP bridge calls bypass capability tokens entirely... anyone who can
 * spawn `berth mcp` against a running container can call any of its
 * exports, with no check against what the app declared it needs"). `--only`
 * doesn't add cryptographic auth (there's still no token verifying *who*
 * is calling), but it does let an operator narrow *what* a spawned bridge
 * can reach to a declared subset instead of blanket "everything this app
 * can do" — least privilege, opt-in, the same shape of improvement
 * `applyHumanApprovalGate`'s own `only` option already has for Agent tool
 * calls. `unknown` names (a typo, or an export the app doesn't declare) are
 * returned rather than silently dropped, so the caller can fail loudly
 * instead of bridging fewer tools than the operator actually intended.
 */
export function parseOnlyExports(only: string, declaredExportNames: string[]): { names: string[]; unknown: string[] } {
  const names = only
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const declared = new Set(declaredExportNames);
  const unknown = names.filter((name) => !declared.has(name));
  return { names, unknown };
}
