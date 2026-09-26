/**
 * Lazy access to `@berthos/agents`, which `@berthos/cli` deliberately does not
 * depend on at runtime.
 *
 * The core CLI — `berth mcp`, `berth doctor`, `berth attest`, `berth dev`, the
 * sandbox lifecycle — is the substrate: a manifest compiled into a kernel
 * policy, plus the evidence for it. `@berthos/agents` is a full agent framework
 * layered on top, and three commands (`berth eval`, `berth agent run`,
 * `berth crew run`) are its CLI surface. A static import of it from any command
 * module makes the framework a hard dependency of the substrate, so installing
 * the thing that holds the boundary pulls in an LLM framework, its providers,
 * and their transitive tree.
 *
 * oclif discovers commands by directory (`oclif.commands` in package.json) and
 * loads a command module only when that command runs, so nothing here costs
 * anything on the common path: `berth doctor` never evaluates this file.
 *
 * Two comments in this repo already refused this dependency for the same reason
 * rather than importing across it — `util/os-config.ts`'s duplicated
 * `resolveComputerApps()` and `commands/os/up.ts`'s duplicated
 * `startHttpRpcServer()`. This is that seam made explicit instead of duplicated.
 *
 * `@berthos/agents` stays a devDependency: the types below are erased at runtime
 * but are needed to typecheck these three commands. If it is absent at runtime,
 * the failure is one clear sentence naming the install, not a module-resolution
 * stack trace.
 */

/** Everything the three framework-backed commands use. Keep this list minimal — it is the seam. */
export type AgentsModule = typeof import("@berthos/agents");

/** True for the error node throws when the package simply is not installed. */
export function isModuleNotFound(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

/**
 * The message someone sees when they run one of the three framework commands
 * on a `@berthos/cli` that has no framework installed. Exported so it is tested
 * directly rather than through a copy of itself.
 */
export function describeMissingFramework(commandId: string): string {
  return (
    `\`berth ${commandId}\` needs the agent framework, which is not installed.\n\n` +
    `  npm install @berthos/agents\n\n` +
    `@berthos/cli does not depend on it: the CLI's own commands (dev, mcp, doctor, attest, os, snapshot) ` +
    `are the sandbox and its evidence, and none of them needs an LLM framework. Only \`eval\`, ` +
    `\`agent run\` and \`crew run\` do.`
  );
}

let cached: AgentsModule | undefined;

export async function loadAgents(commandId: string): Promise<AgentsModule> {
  if (cached) return cached;
  try {
    // Not a static import: see this module's header.
    cached = (await import("@berthos/agents")) as AgentsModule;
    return cached;
  } catch (err) {
    if (isModuleNotFound(err)) throw new Error(describeMissingFramework(commandId));
    // A real failure inside the framework (a broken build, a bad transitive
    // dep) must not be reported as "not installed" — that sends someone to
    // reinstall a package that is already there.
    throw err;
  }
}

/** Exported for tests, which would otherwise share one process-wide cache. */
export function resetAgentsCache(): void {
  cached = undefined;
}
