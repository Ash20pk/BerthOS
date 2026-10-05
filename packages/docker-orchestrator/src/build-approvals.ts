/**
 * pnpm build-script decisions for a Berth app installed outside this monorepo:
 * written to the pnpm-workspace.yaml of every project `berth init` scaffolds,
 * and of an app copied out of the monorepo when its image is staged
 * (image.ts), as `allowBuilds`.
 *
 * pnpm 10 skips an unapproved dependency's install script with a warning;
 * pnpm 11 fails the install instead (ERR_PNPM_IGNORED_BUILDS), and writes
 * "set this to true or false" placeholders it then refuses to proceed past.
 * So every dependency with an install script needs an explicit answer here,
 * or `berth init` leaves a project that doesn't install:
 *
 * - `protobufjs` (via @berthos/sdk's context-bus client): a benign optional-dep
 *   advisory. Allowed.
 * - `@berthos/sdk`: its postinstall prefetches the embedding model, and fails
 *   soft (keyword-only search) if it can't. Allowed.
 * - `sharp` (via @xenova/transformers): downloads a native image library the
 *   SDK never uses, since embeddings are text-only. Declined, as this repo
 *   does with a stub; the SDK falls back to keyword-only ranking without it.
 */
export const SCAFFOLD_BUILD_APPROVALS: Readonly<Record<string, boolean>> = {
  protobufjs: true,
  "@berthos/sdk": true,
  sharp: false,
};
