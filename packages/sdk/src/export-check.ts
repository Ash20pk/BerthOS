// One export's part of `berth test`'s contract check (see check-exports.ts),
// kept apart from that script so it can be tested without running it.
import type { ExportDefinition } from "./app.js";
import { stubValue } from "./stub-value.js";

export interface ExportResult {
  export: string;
  ok: boolean;
  error?: string;
  /** Set when the handler threw on the stub input: not a contract failure, just not exercised. */
  unexercised?: string;
}

/**
 * A TypeError or ReferenceError is the code itself going wrong (a property of
 * undefined, a name that doesn't exist) rather than the handler refusing the
 * made-up input, so it still fails the check. One that carries a `cause` is
 * an I/O failure wearing a TypeError, as fetch's "fetch failed" does, and
 * counts as not exercised like any other refusal.
 */
function isProgrammingError(err: unknown): boolean {
  return (err instanceof TypeError || err instanceof ReferenceError) && err.cause === undefined;
}

/**
 * The contract is the declared shape: the export exists on both sides
 * (checked by the caller) and, when it returns, what it returns matches its
 * output schema. A handler that throws on a made-up input hasn't broken it:
 * git's status has no repository called "berth-test-stub", and a database
 * connector has no database. Failing those made berth test impossible to pass
 * for any app whose exports need state or a service, so they're reported as
 * not exercised instead, unless the error is a programming error.
 */
export async function checkExport(name: string, def: ExportDefinition<unknown, unknown>): Promise<ExportResult> {
  const input = def.input ? stubValue(def.input) : undefined;
  let result: unknown;
  try {
    result = await def.handler(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isProgrammingError(err)) return { export: name, ok: false, error: `threw ${(err as Error).name}: ${message}` };
    return { export: name, ok: true, unexercised: message };
  }
  const parsed = def.output ? def.output.safeParse(result) : { success: true as const };
  if (parsed.success) return { export: name, ok: true };
  return { export: name, ok: false, error: `returned output that doesn't match its declared schema: ${parsed.error.message}` };
}
