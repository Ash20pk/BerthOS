import type { ComputerAppSpec } from "./resolve-apps.js";
import { toolNameFor } from "./tools.js";
import type { Tool } from "./types.js";

/**
 * Thrown when a governance app's `evaluate_action` export denies a tool
 * call. Surfaces to the Agent's tool-use loop as a normal tool-call failure —
 * the LLM sees `.message` (which includes `reason`) the same way it would see
 * any other tool error.
 */
export class GovernanceDeniedError extends Error {
  constructor(
    readonly appName: string,
    readonly exportName: string,
    readonly reason: string,
  ) {
    super(`governance denied ${appName}.${exportName}: ${reason}`);
    this.name = "GovernanceDeniedError";
  }
}

interface EvaluateActionResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Fail-open, not fail-closed: a v1 default, not a security guarantee. A
 * governance app that's slow, crashed, or misbehaving shouldn't wedge every
 * other app's tool calls — see docs/governance-reference.md.
 */
const GOVERNANCE_CALL_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`evaluate_action call timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Wraps every non-exempt app's tools so they route through the Computer's
 * governance app (an app declaring `governs: true` in its berth.yml) first —
 * see docs/governance-reference.md for the full contract. A no-op (returns
 * `tools` unchanged) when no app in this Computer declares `governs: true`.
 *
 * `allApps` and `scopedApps` are deliberately separate: `Computer.connect({
 * apps })` lets a caller expose only a subset of a shared `berth os up`
 * instance's loaded apps as tools (`scopedApps`/`tools`), but the governor
 * itself runs as a resident process in that same container regardless of
 * whether it's in that subset. Detecting `governs: true` from `scopedApps`
 * alone (as this used to) meant a caller who simply didn't name the
 * governance app in `apps` got ungated tool calls with no warning — the
 * gate silently depended on which apps a caller happened to list, even
 * though every call still dispatched into the one container where the
 * governor is actually running. Checking `allApps` instead means gating
 * still applies whenever the underlying OS/Computer has a governor loaded
 * at all, however the caller scoped their own tool list. `call` (the same
 * transport dispatch computerToolsFor() uses to build `tools`) is what
 * actually invokes the governor's `evaluate_action` — reaching it doesn't
 * require the governor's own tool to be present in `tools`, only that
 * `call(governorName, "evaluate_action", ...)` can reach that resident app,
 * which is always true within one Computer/OS instance.
 *
 * This is @berth/agents' own choke point, not a kernel mechanism: it only
 * gates tool calls made through Computer/Agent, not `berth rpc` or direct
 * multi-app `invokeAppExport()` calls. Landlock has no per-syscall callback
 * to build a kernel-level version of this on — see
 * docs/capability-tokens-reference.md's "what's deliberately deferred".
 */
export function applyGovernanceGate(
  allApps: ComputerAppSpec[],
  scopedApps: ComputerAppSpec[],
  tools: Tool[],
  call: (appName: string, exportName: string, input: unknown) => Promise<unknown>,
): Tool[] {
  const governors = allApps.filter((app) => app.manifest.governs);
  if (governors.length === 0) return tools;
  if (governors.length > 1) {
    throw new Error(
      `multiple governance apps declared (${governors.map((app) => app.name).join(", ")}) — only one governance authority per Computer is supported`,
    );
  }
  const governorName = governors[0]!.name;
  const namespaced = scopedApps.length > 1;

  const ownerByToolName = new Map<string, { appName: string; exportName: string; exempt: boolean }>();
  for (const app of scopedApps) {
    for (const exportSpec of app.manifest.exports) {
      ownerByToolName.set(toolNameFor(app.name, exportSpec.name, namespaced), {
        appName: app.name,
        exportName: exportSpec.name,
        exempt: app.name === governorName || app.manifest.governance.exempt,
      });
    }
  }

  return tools.map((tool) => {
    const owner = ownerByToolName.get(tool.name);
    if (!owner || owner.exempt) return tool;

    return {
      ...tool,
      invoke: async (input: unknown) => {
        let verdict: EvaluateActionResult;
        try {
          verdict = (await withTimeout(
            call(governorName, "evaluate_action", { app: owner.appName, export: owner.exportName, input }),
            GOVERNANCE_CALL_TIMEOUT_MS,
          )) as EvaluateActionResult;
        } catch (err) {
          console.warn(
            `[governance] evaluate_action call failed (${(err as Error).message}) — failing open for ${owner.appName}.${owner.exportName}`,
          );
          return tool.invoke(input);
        }
        if (!verdict.allowed) {
          throw new GovernanceDeniedError(owner.appName, owner.exportName, verdict.reason ?? "denied");
        }
        return tool.invoke(input);
      },
    };
  });
}
