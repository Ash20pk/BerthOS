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
 * This is @berth/agents' own choke point, not a kernel mechanism: it only
 * gates tool calls made through Computer/Agent, not `berth rpc` or direct
 * multi-app `invokeAppExport()` calls. Landlock has no per-syscall callback
 * to build a kernel-level version of this on — see
 * docs/capability-tokens-reference.md's "what's deliberately deferred".
 */
export function applyGovernanceGate(apps: ComputerAppSpec[], tools: Tool[]): Tool[] {
  const governors = apps.filter((app) => app.manifest.governs);
  if (governors.length === 0) return tools;
  if (governors.length > 1) {
    throw new Error(
      `multiple governance apps declared (${governors.map((app) => app.name).join(", ")}) — only one governance authority per Computer is supported`,
    );
  }
  const governorName = governors[0]!.name;
  const namespaced = apps.length > 1;
  const evaluateToolName = toolNameFor(governorName, "evaluate_action", namespaced);
  const evaluateTool = tools.find((tool) => tool.name === evaluateToolName);
  if (!evaluateTool) {
    // Shouldn't happen: BerthManifestSchema already requires an evaluate_action
    // export whenever governs: true is set, so this would mean apps/tools got
    // out of sync with each other, not a normal user-facing misconfiguration.
    throw new Error(`governance app "${governorName}" is missing its "evaluate_action" tool`);
  }

  const ownerByToolName = new Map<string, { appName: string; exportName: string; exempt: boolean }>();
  for (const app of apps) {
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
            evaluateTool.invoke({ app: owner.appName, export: owner.exportName, input }),
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
