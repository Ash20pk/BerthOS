/**
 * Key-name patterns whose values never reach a record. Matched
 * case-insensitively against the key, as a substring, so "apiKey",
 * "ANTHROPIC_API_KEY" and "x-api-key" all match "key".
 *
 * A deny-list is the wrong default in general — it fails open on the name
 * nobody thought of. It is the right one *here* because the alternative
 * (an allow-list) would strip the arguments an auditor actually opened the
 * file to read, and payload capture is already opt-in per REMEDIATION.md 5.4:
 * this is the second line of defence, not the only one.
 */
const SECRET_KEY_PATTERNS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "auth",
  "credential",
  "private_key",
  "privatekey",
  "session",
  "cookie",
  "signature",
];

export const REDACTED = "[redacted]";

/** Values longer than this are replaced with a size marker rather than stored. */
const DEFAULT_MAX_STRING = 2048;
/** Arrays longer than this keep their head and record how many were dropped. */
const DEFAULT_MAX_ARRAY = 50;
/** Guards against a cyclic or pathologically deep payload turning into an unbounded record. */
const MAX_DEPTH = 8;

export interface RedactOptions {
  maxStringLength?: number;
  maxArrayLength?: number;
  /** Extra key substrings to treat as secret, on top of the built-in list. */
  additionalSecretKeys?: string[];
}

function isSecretKey(key: string, extra: string[]): boolean {
  const lower = key.toLowerCase().replace(/[-\s]/g, "_");
  return SECRET_KEY_PATTERNS.some((p) => lower.includes(p)) || extra.some((p) => lower.includes(p.toLowerCase()));
}

/**
 * Makes an arbitrary payload safe to write to an audit record: secret-looking
 * keys are replaced, oversized strings and arrays are truncated with a marker
 * saying so, and anything that isn't JSON-representable is described rather
 * than dropped silently.
 *
 * Truncation leaves a marker rather than the raw prefix on purpose — a
 * half-written credential is still a credential, and a reader who sees
 * `<8.2KB string, not captured>` knows something was there, which a silently
 * shortened value would not tell them.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const maxString = options.maxStringLength ?? DEFAULT_MAX_STRING;
  const maxArray = options.maxArrayLength ?? DEFAULT_MAX_ARRAY;
  const extraKeys = options.additionalSecretKeys ?? [];
  const seen = new WeakSet<object>();

  function walk(node: unknown, depth: number): unknown {
    if (node === null || node === undefined) return node;

    const t = typeof node;
    if (t === "string") {
      const s = node as string;
      if (s.length > maxString) return `<${formatBytes(Buffer.byteLength(s))} string, not captured>`;
      return s;
    }
    if (t === "number" || t === "boolean") return node;
    if (t === "bigint") return `${(node as bigint).toString()}n`;
    if (t === "function") return "<function>";
    if (t === "symbol") return (node as symbol).toString();

    if (depth >= MAX_DEPTH) return "<max depth>";

    if (node instanceof Date) return node.toISOString();
    if (node instanceof Error) return { name: node.name, message: node.message };
    if (Buffer.isBuffer(node)) return `<${formatBytes(node.byteLength)} buffer, not captured>`;

    if (seen.has(node as object)) return "<circular>";
    seen.add(node as object);

    if (Array.isArray(node)) {
      const head = node.slice(0, maxArray).map((item) => walk(item, depth + 1));
      if (node.length > maxArray) head.push(`<${node.length - maxArray} more items>`);
      return head;
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      out[key] = isSecretKey(key, extraKeys) ? REDACTED : walk(child, depth + 1);
    }
    return out;
  }

  return walk(value, 0);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}
