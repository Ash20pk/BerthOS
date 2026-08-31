import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ExportSpecType, JsonPrimitiveTypeName } from "@berth/manifest-schema";
import type { ComputerAppSpec } from "./resolve-apps.js";
import type { Tool } from "./types.js";

/**
 * Same primitive-type switch as @berth/cli's mcp-tools.ts zodFor() — berth.yml's
 * IOSpec is intentionally flat (no nesting), so this is strictly a
 * schema-shape mapping, not a re-derivation of whatever richer Zod schema the
 * app author wrote in app.export({input: ...}) (that never crosses the RPC
 * wire, so it isn't available here).
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

export function inputSchemaFor(exportSpec: ExportSpecType): object {
  const input = exportSpec.input ?? {};
  const shape = Object.fromEntries(Object.entries(input).map(([field, type]) => [field, zodFor(type)]));
  // zod-to-json-schema's published types still target zod v3's ZodType shape; the zod v4
  // object we build here is runtime-compatible but doesn't structurally match those types.
  return zodToJsonSchema(z.object(shape) as unknown as Parameters<typeof zodToJsonSchema>[0]);
}

/**
 * Tool names are `<exportName>` for a single app, `<appName>__<exportName>`
 * when there's more than one (avoids collisions across apps; "__" rather
 * than "." since tool names must satisfy `^[a-zA-Z0-9_-]+$` for most LLM
 * providers). Shared with governance.ts, which needs to map a Tool back to
 * the app/export that owns it.
 */
export function toolNameFor(appName: string, exportName: string, namespaced: boolean): string {
  return namespaced ? `${appName}__${exportName}` : exportName;
}

/**
 * One Tool per export across every app in a Computer.
 *
 * `call` is Computer's own transport dispatch (createStdioRpcClient for a
 * single app, invokeAppExport per call for multi-app) — this function only
 * knows about manifests and schema generation, never about containers.
 */
export function computerToolsFor(
  apps: ComputerAppSpec[],
  call: (appName: string, exportName: string, input: unknown) => Promise<unknown>,
): Tool[] {
  const namespaced = apps.length > 1;
  const tools: Tool[] = [];

  for (const app of apps) {
    for (const exportSpec of app.manifest.exports) {
      tools.push({
        name: toolNameFor(app.name, exportSpec.name, namespaced),
        description: `Berth resident app export "${exportSpec.name}" (from ${app.name}'s berth.yml)`,
        inputSchema: inputSchemaFor(exportSpec),
        invoke: (input: unknown) => call(app.name, exportSpec.name, input),
      });
    }
  }

  return tools;
}
