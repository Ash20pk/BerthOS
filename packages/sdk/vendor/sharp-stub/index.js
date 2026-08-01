// @xenova/transformers imports `sharp` unconditionally at module load time
// (src/utils/image.js) and THROWS at load time if it's falsy (there's no
// browser environment and no working sharp) — so this stub must be truthy,
// not null/undefined, purely to satisfy that load-time check. Real `sharp`
// needs a platform-specific prebuilt native binary that isn't available (or
// approved to build) in this workspace; this SDK only ever uses
// feature-extraction/text pipelines, never image ones, so the stub only
// needs to exist — it's never actually called. It throws loudly if it ever
// is, rather than silently misbehaving.
module.exports = function sharpStub() {
  throw new Error(
    "sharp is stubbed out in this build (see packages/sdk/vendor/sharp-stub) — only text/feature-extraction embedding pipelines are supported, not image ones",
  );
};

