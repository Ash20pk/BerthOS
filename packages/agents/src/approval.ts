import type { GrantRecord } from "@berth/grants-server";
import type { Tool } from "./types.js";

/**
 * Thrown when a gated tool call is denied by a human, or times out waiting
 * for one to decide (fail-closed — see timeoutMs below).
 *
 * **Ends the run.** Agent.run()'s tool loop lets this propagate rather than
 * converting it to an `{error}` tool result, unlike GovernanceDeniedError
 * (governance.ts) and unlike ordinary tool failures. That difference is the
 * point: a policy engine denying one action is shaping which action an agent
 * takes, and letting the model try something else is intended. A human
 * denying a specific request is a stop — and feeding it back as a result let
 * the model re-issue the identical call, opening a fresh grant and spamming
 * the person who just said no. See REMEDIATION 3.4 and refusal.test.ts.
 */
export class HumanApprovalDeniedError extends Error {
  constructor(
    readonly toolName: string,
    readonly reason: string,
  ) {
    super(`human approval denied for "${toolName}": ${reason}`);
    this.name = "HumanApprovalDeniedError";
  }
}

export interface HumanApprovalGateOptions {
  /** Base URL of a running grants-server instance (`berth-grants`, see @berth/grants-server), e.g. "http://127.0.0.1:4874". */
  grantsServerUrl: string;
  /** Attributed as the grant's `appName` — typically the Agent's name, so `berth grants list` shows which agent is asking. */
  requesterName: string;
  /** Only these tool names require approval; every other tool call passes through untouched. Omit to gate every tool in the list. */
  only?: string[];
  /** How often to poll GET /grants/:id while waiting for a human to decide. Default 2000ms. */
  pollIntervalMs?: number;
  /**
   * How long to wait for a decision before treating the call as denied.
   * Fail-**closed**, deliberately the opposite of governance.ts's fail-open:
   * a human-approval gate that silently let calls through on timeout
   * wouldn't be a human-in-the-loop gate at all. Default 10 minutes.
   */
  timeoutMs?: number;
}

async function requestGrant(baseUrl: string, appName: string, capability: string, reason: string): Promise<GrantRecord> {
  const res = await fetch(`${baseUrl}/grants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appName, capability, reason }),
  });
  if (!res.ok) {
    throw new Error(`grants-server POST /grants failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as GrantRecord;
}

async function fetchGrant(baseUrl: string, id: string): Promise<GrantRecord> {
  const res = await fetch(`${baseUrl}/grants/${id}`);
  if (!res.ok) {
    throw new Error(`grants-server GET /grants/${id} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as GrantRecord;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Blocks — polling, not restarting a container the way the boot-time
 * capability-policy consumer does, since there's no container to restart
 * mid-Agent.run() — until a human decides via `berth grants approve/deny`
 * (or the REST API directly), or `timeoutMs` elapses.
 */
async function awaitDecision(baseUrl: string, id: string, pollIntervalMs: number, timeoutMs: number): Promise<GrantRecord> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const grant = await fetchGrant(baseUrl, id);
    if (grant.status !== "pending") return grant;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for a human decision on grant "${id}"`);
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Generalizes grants-server's existing approve/deny pattern from "container
 * gets this filesystem capability" (capability tokens, decided on at the
 * app's *next boot*) to "this agent gets to take its next action" (decided
 * on live, blocking the call that's asking) — the human-in-the-loop LangGraph
 * covers with `interrupt()`/`Command(resume=...)`. Reuses grants-server's
 * request/approve/deny/webhook machinery as-is (a capability here is just
 * `agent-action:<toolName>`, and the tool call's input is the request's
 * `reason`); does not touch generate-capability-policy.ts or Landlock, which
 * are boot-time-only and orthogonal to gating a live tool call.
 *
 * Same "wraps a tool list" shape as applyGovernanceGate(), but simpler:
 * grants-server is a plain host-reachable HTTP service, not something that
 * has to be resolved from a Computer's resident apps the way Semantic FS/
 * Context Bus do, so there's no Computer/manifest plumbing here at all.
 */
export function applyHumanApprovalGate(tools: Tool[], options: HumanApprovalGateOptions): Tool[] {
  const gated = options.only ? new Set(options.only) : undefined;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;

  return tools.map((tool) => {
    if (gated && !gated.has(tool.name)) return tool;

    return {
      ...tool,
      invoke: async (input: unknown) => {
        const grant = await requestGrant(
          options.grantsServerUrl,
          options.requesterName,
          `agent-action:${tool.name}`,
          JSON.stringify(input),
        );

        let decided: GrantRecord;
        try {
          decided = await awaitDecision(options.grantsServerUrl, grant.id, pollIntervalMs, timeoutMs);
        } catch (err) {
          throw new HumanApprovalDeniedError(tool.name, err instanceof Error ? err.message : String(err));
        }
        if (decided.status !== "approved") {
          throw new HumanApprovalDeniedError(tool.name, decided.reason ?? "denied");
        }
        return tool.invoke(input);
      },
    };
  });
}
