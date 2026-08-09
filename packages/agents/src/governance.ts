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

/**
 * Thrown instead of GovernanceDeniedError when `mode: "fail-closed"` is
 * configured and the governor itself couldn't be reached in time — a
 * distinct error from "the governor said no," since the governor never
 * actually rendered a verdict here. See applyGovernanceGate()'s `mode`.
 */
export class GovernanceUnavailableError extends Error {
  constructor(
    readonly appName: string,
    readonly exportName: string,
    readonly cause: string,
  ) {
    super(`governance unavailable for ${appName}.${exportName} (fail-closed): ${cause}`);
    this.name = "GovernanceUnavailableError";
  }
}

interface EvaluateActionResult {
  allowed: boolean;
  reason?: string;
}

export interface GovernanceGateOptions {
  /**
   * "fail-closed" (default): a governor that's slow, crashed, or unreachable
   * makes the call throw GovernanceUnavailableError rather than run — "the
   * policy check didn't happen" never quietly becomes "the policy check
   * passed."
   *
   * This default was inverted for REMEDIATION.md 1.11, and the reason is the
   * other half of that item: any app in the container can `kill -9` the
   * governance app. Under the old fail-open default that was a complete
   * bypass of the gate — one signal and every subsequent call executed with
   * a `console.warn` — which made the governor's authority contingent on
   * nothing more than its own uptime. Per-app uids now make that specific
   * kill impossible (the kernel refuses cross-uid signals), but a governor
   * can still crash, hang, or be slow, and a gate that opens under those
   * conditions is not a gate.
   *
   * "fail-open" is still available and is a legitimate choice where
   * availability genuinely matters more than the guarantee — a governor
   * outage then takes down every gated app's tool calls instead. It is no
   * longer what you get by not deciding.
   *
   * An explicitly-denied call throws GovernanceDeniedError either way; `mode`
   * only decides what happens when the governor can't be consulted at all.
   * See docs/governance-reference.md.
   */
  mode?: "fail-open" | "fail-closed";
}

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
 * This is @berth/agents' own choke point, not a kernel mechanism: it gates
 * what goes through Computer/Agent, not `berth rpc`, `berth mcp`, the HTTP
 * RPC bridge, or direct multi-app `invokeAppExport()` calls — separate
 * transports into the same container, with no governance app on their path
 * (REMEDIATION.md 1.13 closes the in-process bypasses; those transports are
 * recorded there as still open). Landlock has no per-syscall callback
 * to build a kernel-level version of this on — see
 * docs/capability-tokens-reference.md's "what's deliberately deferred".
 */
/**
 * The identity a gated action is announced to the governor under. For a
 * resident app it is simply the app and export names. For the two paths that
 * have no resident app behind them at all, it is synthetic and namespaced —
 * see gateExternalTool().
 */
export interface GovernedAction {
  app: string;
  export: string;
}

/**
 * The one place a verdict is obtained and enforced. Everything else in this
 * file is about deciding *what* to route through here.
 */
async function enforce<T>(
  action: GovernedAction,
  input: unknown,
  proceed: () => Promise<T>,
  askGovernor: (input: unknown) => Promise<unknown>,
  mode: "fail-open" | "fail-closed",
): Promise<T> {
  let verdict: EvaluateActionResult;
  try {
    verdict = (await withTimeout(
      askGovernor({ app: action.app, export: action.export, input }),
      GOVERNANCE_CALL_TIMEOUT_MS,
    )) as EvaluateActionResult;
  } catch (err) {
    const cause = (err as Error).message;
    if (mode === "fail-closed") throw new GovernanceUnavailableError(action.app, action.export, cause);
    console.warn(`[governance] evaluate_action call failed (${cause}) — failing open for ${action.app}.${action.export}`);
    return proceed();
  }
  if (!verdict.allowed) throw new GovernanceDeniedError(action.app, action.export, verdict.reason ?? "denied");
  return proceed();
}

/**
 * A Computer's governance authority, resolved once, in a form every caller
 * can route through — REMEDIATION.md 1.13.
 *
 * The gate used to be applied by mapping over one particular `Tool[]`, which
 * meant it protected exactly the tools that happened to be in that array at
 * that moment and nothing else. Anything assembled afterwards (MCP servers,
 * a delegated agent) or dispatched by another route (`computer.call`) simply
 * wasn't in the array and so was never gated. `gateDispatch()` moves the
 * check onto the dispatch function itself, so it covers every call that
 * reaches a resident app through this Computer rather than one snapshot of a
 * list; `gateExternalTool()` covers the paths that never touch that dispatch.
 *
 * Returns undefined when no app declares `governs: true` — callers then use
 * their unwrapped dispatch, and nothing here has any cost.
 */
export interface GovernanceGate {
  governorName: string;
  /** Wraps a dispatch function so every resident-app call through it is gated. */
  gateDispatch(
    dispatch: (appName: string, exportName: string, input: unknown) => Promise<unknown>,
  ): (appName: string, exportName: string, input: unknown) => Promise<unknown>;
  /** Wraps a Tool that has no resident app behind it (MCP, agent-as-tool). */
  gateExternalTool(tool: Tool, action: GovernedAction): Tool;
}

export function resolveGovernanceGate(
  allApps: ComputerAppSpec[],
  call: (appName: string, exportName: string, input: unknown) => Promise<unknown>,
  options: GovernanceGateOptions = {},
): GovernanceGate | undefined {
  const mode = options.mode ?? "fail-closed";
  const governors = allApps.filter((app) => app.manifest.governs);
  if (governors.length === 0) return undefined;
  if (governors.length > 1) {
    throw new Error(
      `multiple governance apps declared (${governors.map((app) => app.name).join(", ")}) — only one governance authority per Computer is supported`,
    );
  }
  const governorName = governors[0]!.name;
  const exemptApps = new Set(allApps.filter((app) => app.manifest.governance.exempt).map((app) => app.name));
  const askGovernor = (input: unknown) => call(governorName, "evaluate_action", input);

  return {
    governorName,
    gateDispatch(dispatch) {
      return async (appName, exportName, input) => {
        // The governor's own exports are never gated — routing
        // evaluate_action through the gate would recurse forever, and this
        // is the dispatch the gate itself calls.
        if (appName === governorName || exemptApps.has(appName)) return dispatch(appName, exportName, input);
        return enforce({ app: appName, export: exportName }, input, () => dispatch(appName, exportName, input), askGovernor, mode);
      };
    },
    gateExternalTool(tool, action) {
      return {
        ...tool,
        invoke: (input: unknown) => enforce(action, input, () => tool.invoke(input), askGovernor, mode),
      };
    },
  };
}

export function applyGovernanceGate(
  allApps: ComputerAppSpec[],
  scopedApps: ComputerAppSpec[],
  tools: Tool[],
  call: (appName: string, exportName: string, input: unknown) => Promise<unknown>,
  options: GovernanceGateOptions = {},
): Tool[] {
  const mode = options.mode ?? "fail-closed";
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
          const cause = (err as Error).message;
          if (mode === "fail-closed") {
            throw new GovernanceUnavailableError(owner.appName, owner.exportName, cause);
          }
          console.warn(`[governance] evaluate_action call failed (${cause}) — failing open for ${owner.appName}.${owner.exportName}`);
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
