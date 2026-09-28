/**
 * A stand-in for `sharp`, which @xenova/transformers imports unconditionally
 * at load time (src/utils/image.js) and refuses to load without: it throws if
 * the import is falsy. Real sharp needs a platform-specific native binary
 * that sandbox images don't carry and `berth init` declines to build. This
 * SDK only runs text feature-extraction, never image pipelines, so the stub
 * only has to exist. It throws loudly if anything ever calls it.
 *
 * The repo root's pnpm override to vendor/sharp-stub only worked inside a
 * clone: in an image the override's symlink pointed at the builder's machine,
 * and an npm install never had it.
 */
const SHARP_STUB_SOURCE =
  "export default function sharp() { throw new Error('sharp is stubbed out in @berthos/sdk: only text embedding pipelines are supported, not image ones'); }";
const SHARP_STUB_URL = `data:text/javascript,${encodeURIComponent(SHARP_STUB_SOURCE)}`;

/**
 * Module-resolution hook, registered with module.register() by embeddings.ts
 * just before it imports @xenova/transformers. It answers `import "sharp"`
 * with the stub above, but only when the importer lives inside the
 * @xenova/transformers package: the hook applies to the whole thread, and a
 * resident app that depends on the real sharp must keep getting it.
 *
 * Both are data: URLs rather than files next to this module, so they need
 * nothing on disk: the external build (scripts/build-external.mjs) bundles
 * this module into index.js and runtime.js, and a separate hook file would
 * not be there to resolve.
 */
const SHARP_HOOK_SOURCE = `
const STUB_URL = ${JSON.stringify(SHARP_STUB_URL)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "sharp" && typeof context.parentURL === "string" && context.parentURL.includes("/@xenova/transformers/")) {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
export const SHARP_HOOK_URL = `data:text/javascript,${encodeURIComponent(SHARP_HOOK_SOURCE)}`;
