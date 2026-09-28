/**
 * Module-resolution hook that answers every `import "sharp"` with the SDK's
 * own stub (sharp-stub.ts). Registered with module.register() by
 * embeddings.ts, just before it imports @xenova/transformers.
 */
const STUB_URL = new URL("./sharp-stub.js", import.meta.url).href;

type Resolve = (specifier: string, context: unknown) => Promise<{ url: string; shortCircuit?: boolean }>;

export async function resolve(specifier: string, context: unknown, nextResolve: Resolve): Promise<{ url: string; shortCircuit?: boolean }> {
  if (specifier === "sharp") return { url: STUB_URL, shortCircuit: true };
  return nextResolve(specifier, context);
}
