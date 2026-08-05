import type { z } from "zod";

/**
 * Thrown when Agent.run()/resume() exhausts its repair attempts without the
 * model ever producing text that parses as JSON matching `responseSchema` —
 * `rawText` is the model's last (still-invalid) attempt, for a caller that
 * wants to log or salvage it rather than just seeing the thrown message.
 */
export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly rawText: string,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

export type StructuredOutputResult<T> = { success: true; data: T } | { success: false; error: string };

/**
 * Parses `text` as JSON and validates it against `schema` — the two failure
 * modes LangChain's `.with_structured_output()` repair loop feeds back to
 * the model (not valid JSON at all; valid JSON that doesn't match the
 * schema), collapsed into one human-readable `error` string suitable for
 * putting straight into a corrective prompt.
 */
export function parseStructuredOutput<T>(text: string, schema: z.ZodType<T>): StructuredOutputResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { success: false, error: `response is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  const result = schema.safeParse(json);
  if (result.success) {
    return { success: true, data: result.data };
  }

  return { success: false, error: formatZodIssues(result.error.issues) };
}

function formatZodIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/**
 * Zod's default ZodError.message is JSON.stringify(issues) — that's what a
 * tool's thrown ZodError carries whether it's an in-process Tool (a real
 * ZodError instance) or a resident-app export's input validation crossing
 * the RPC wire (already unwrapped to a plain Error(message) string by the
 * time it reaches Agent.run()'s catch block, per Computer's dispatch() — so
 * `instanceof ZodError` would never match the far more common resident-app
 * case). Detecting the shape of the *message string itself*, not the error
 * type, is what makes this work identically for either path, and for any
 * tool in any app, not one specific export — reformats it into the same
 * compact `path: message; path: message` shape parseStructuredOutput()
 * already produces, instead of leaving the model to parse a raw JSON array.
 * Any other error message (not a Zod issues array) passes through unchanged.
 */
export function formatToolInputError(message: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return message;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return message;
  const looksLikeZodIssues = parsed.every(
    (issue) => issue && typeof issue === "object" && Array.isArray((issue as { path?: unknown }).path) && typeof (issue as { message?: unknown }).message === "string",
  );
  if (!looksLikeZodIssues) return message;

  return formatZodIssues(parsed as { path: PropertyKey[]; message: string }[]);
}

/** The corrective nudge fed back to the model as a fresh user turn on a failed attempt. */
export function structuredOutputRepairPrompt(error: string): string {
  return (
    `Your previous response could not be parsed as valid JSON matching the required schema:\n${error}\n\n` +
    `Respond again with ONLY corrected JSON matching the schema — no prose, no markdown code fences.`
  );
}
