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

  const issues = result.error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("; ");
  return { success: false, error: issues };
}

/** The corrective nudge fed back to the model as a fresh user turn on a failed attempt. */
export function structuredOutputRepairPrompt(error: string): string {
  return (
    `Your previous response could not be parsed as valid JSON matching the required schema:\n${error}\n\n` +
    `Respond again with ONLY corrected JSON matching the schema — no prose, no markdown code fences.`
  );
}
