import { parseDocument, LineCounter } from "yaml";
import type { ZodIssue } from "zod";
import { BerthManifestSchema, type BerthManifest } from "./schema.js";

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

/** Programmatic validation of an already-parsed object (no YAML/line info). */
export function validateManifest(obj: unknown): BerthManifest {
  const result = BerthManifestSchema.safeParse(obj);
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

  const result = BerthManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new ManifestValidationError(zodIssuesToManifestIssues(result.error.issues, lineCounter, doc), path);
  }
  return result.data;
}
