import { parseDocument, LineCounter } from "yaml";
import type { ZodIssue } from "zod";
import { BerthManifestSchema, type BerthManifest } from "./schema.js";
import { CURRENT_SCHEMA_VERSION, migrateToCurrent } from "./migrations.js";

export interface ManifestIssue {
  message: string;
  path: (string | number)[];
  line?: number;
  column?: number;
}

export class ManifestValidationError extends Error {
  issues: ManifestIssue[];

  constructor(issues: ManifestIssue[], sourcePath?: string) {
    const summary = issues
      .map((issue) => {
        const loc = issue.line != null ? `${sourcePath ?? "berth.yml"}:${issue.line}` : sourcePath ?? "berth.yml";
        const field = issue.path.length ? issue.path.join(".") : "(root)";
        return `${loc} ${field}: ${issue.message}`;
      })
      .join("\n");
    super(`invalid berth.yml:\n${summary}`);
    this.name = "ManifestValidationError";
    this.issues = issues;
  }
}

function zodIssuesToManifestIssues(
  zodIssues: ZodIssue[],
  lineCounter: LineCounter | undefined,
  doc: ReturnType<typeof parseDocument> | undefined,
): ManifestIssue[] {
  return zodIssues.map((issue) => {
    const manifestIssue: ManifestIssue = { message: issue.message, path: issue.path as (string | number)[] };
    if (doc && lineCounter) {
      const node = doc.getIn(issue.path, true) as { range?: [number, number, number] } | undefined;
      if (node?.range) {
        const pos = lineCounter.linePos(node.range[0]);
        manifestIssue.line = pos.line;
        manifestIssue.column = pos.col;
      }
    }
    return manifestIssue;
  });
}

/**
 * `schema_version` is metadata ABOUT the file (which shape its author wrote
 * it against), not part of the semantically-validated manifest the rest of
 * the codebase consumes — resolved and consumed here, before
 * BerthManifestSchema (which has no notion of versioning at all — it only
 * ever validates "today's current shape") ever sees the object. Absent
 * entirely is treated as CURRENT_SCHEMA_VERSION, not as some ambiguous
 * "version 0": every berth.yml written before this field existed must keep
 * validating exactly as it always has, with zero behavior change.
 *
 * A declared version newer than this installed package supports fails
 * immediately with a clear, actionable error — the alternative (silently
 * validating it against a schema it was never written for) is exactly the
 * "silent misinterpretation" this whole mechanism exists to prevent.
 */
function resolveSchemaVersion(raw: Record<string, unknown>, sourcePath?: string): Record<string, unknown> {
  const declared = raw.schema_version;
  if (declared === undefined) return raw;

  if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 0) {
    throw new Error(`invalid berth.yml${sourcePath ? ` (${sourcePath})` : ""}: schema_version must be a non-negative integer, got ${JSON.stringify(declared)}`);
  }
  if (declared > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `invalid berth.yml${sourcePath ? ` (${sourcePath})` : ""}: declares schema_version: ${declared}, but this installed ` +
        `@berth/manifest-schema only supports up to ${CURRENT_SCHEMA_VERSION}. Upgrade @berth/manifest-schema to load this file.`,
    );
  }
  if (declared === CURRENT_SCHEMA_VERSION) return raw;

  try {
    return migrateToCurrent(raw, declared);
  } catch (err) {
    throw new Error(`invalid berth.yml${sourcePath ? ` (${sourcePath})` : ""}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Programmatic validation of an already-parsed object (no YAML/line info). */
export function validateManifest(obj: unknown): BerthManifest {
  const migrated = resolveSchemaVersion(obj as Record<string, unknown>);
  const result = BerthManifestSchema.safeParse(migrated);
  if (!result.success) {
    throw new ManifestValidationError(
      result.error.issues.map((issue) => ({ message: issue.message, path: issue.path as (string | number)[] })),
    );
  }
  return result.data;
}

/** Loads and validates a berth.yml file from disk, with line-numbered errors. */
export async function loadManifest(path: string): Promise<BerthManifest> {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(path, "utf-8");

  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter });
  const raw = doc.toJS();
  const migrated = resolveSchemaVersion(raw, path);

  const result = BerthManifestSchema.safeParse(migrated);
  if (!result.success) {
    throw new ManifestValidationError(zodIssuesToManifestIssues(result.error.issues, lineCounter, doc), path);
  }
  return result.data;
}
