import { z } from "zod";

/**
 * Capability strings are "namespace:action:scope", where scope may contain a
 * glob (*), e.g. "github:read:repos", "browser:navigate:*.github.com",
 * "filesystem:read:/workspace". This grammar is enforced here and consumed
 * by capability.ts's parser/matcher — the same data shape Phase 3's kernel
 * capability-token issuer will consume, though Phase 1 never enforces it.
 */
export const CapabilityString = z
  .string()
  .regex(/^[a-z0-9_-]+:[a-z0-9_-]+:.+$/, "capability must be 'namespace:action:scope'");

export const JsonPrimitiveType = z.enum(["string", "number", "boolean", "object", "array"]);

/**
 * input/output blocks are a flat map of field name -> primitive type name.
 * Phase 1 keeps this intentionally simple (no nested objects) — it's the
 * wire-contract subset the SDK's RPC layer needs to generate stub validators.
 */
export const IOSpec = z.record(z.string(), JsonPrimitiveType);

export const ExportSpec = z.object({
  name: z.string(),
  input: IOSpec.optional(),
  output: IOSpec.optional(),
});

/**
 * Declaring browser:* or terminal:* only grants the capability (Landlock,
 * egress broker, etc.) — whether `berth dev` also publishes the
 * corresponding VNC/CDP/ttyd port to the host is a separate choice, made
 * here. Both default to true so an existing berth.yml with no `expose:`
 * block keeps today's behavior (capability declared => port published).
 * Deploy targets (E2B/Daytona/K8s) don't publish these ports at all yet
 * regardless of this setting — see docs/manifest-reference.md.
 */
export const ExposeSpec = z
  .object({
    browser: z.boolean().default(true),
    terminal: z.boolean().default(true),
  })
  .default({});

/**
 * `governance.exempt` lets an app opt out of another loaded app's `governs: true`
 * gate — see the `governs` field below. Default false: every app is governed
 * by default once a governance authority is present in the same Computer.
 */
export const GovernanceSpec = z
  .object({
    exempt: z.boolean().default(false),
  })
  .default({});

export const BerthManifestSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/, "name must be lowercase alphanumeric with dashes"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver (x.y.z)"),
    /** Optional human-readable summary — surfaced by the Phase 5 registry's listing/search, unused before that. */
    description: z.string().default(""),
    capabilities: z.array(CapabilityString).default([]),
    exports: z.array(ExportSpec).default([]),
    on_install: z.array(z.string()).default([]),
    on_agent_ready: z.array(z.string()).default([]),
    expose: ExposeSpec,
    /**
     * Declares this app as its Computer's governance authority: every other
     * app's tool calls get routed through this app's `evaluate_action` export
     * first (enforced by @berth/agents' Computer, not the kernel — see
     * docs/governance-reference.md). Default false. At most one app per
     * Computer may set this to true.
     */
    governs: z.boolean().default(false),
    governance: GovernanceSpec,
  })
  .superRefine((manifest, ctx) => {
    if (manifest.governs && !manifest.exports.some((exportSpec) => exportSpec.name === "evaluate_action")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["governs"],
        message: "an app declaring governs: true must also declare an 'evaluate_action' export",
      });
    }
  });

export type BerthManifest = z.infer<typeof BerthManifestSchema>;
export type ExportSpecType = z.infer<typeof ExportSpec>;
export type JsonPrimitiveTypeName = z.infer<typeof JsonPrimitiveType>;
export type GovernanceSpecType = z.infer<typeof GovernanceSpec>;
export type ExposeSpecType = z.infer<typeof ExposeSpec>;
