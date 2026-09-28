/**
 * A stand-in for `sharp`, which @xenova/transformers imports unconditionally
 * at load time (src/utils/image.js) and refuses to load without: it throws if
 * the import is falsy. Real sharp needs a platform-specific native binary
 * that sandbox images don't carry and `berth init` declines to build. This
 * SDK only runs text feature-extraction, never image pipelines, so the stub
 * only has to exist. It throws loudly if anything ever calls it.
 *
 * Shipped as part of the SDK's own build and wired in by sharp-hook.ts, so
 * it resolves wherever the SDK is installed. The repo root's pnpm override
 * to vendor/sharp-stub only worked inside a clone: in an image the override's
 * symlink pointed at the builder's machine, and an npm install never had it.
 */
export default function sharpStub(): never {
  throw new Error("sharp is stubbed out in @berthos/sdk: only text embedding pipelines are supported, not image ones");
}
