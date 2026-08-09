import * as net from "node:net";

/**
 * The governance gate at the SDK's own RPC dispatch — REMEDIATION.md 1.13's
 * second half.
 *
 * @berth/agents already gates what goes through a Computer, and that covers
 * the agent loop, `computer.call()`, MCP tools and agent-as-tool delegation.
 * What it cannot cover are the *other* ways into the same container: `berth
 * rpc`, `berth mcp`, the HTTP RPC bridge, the TCP listener, and a sibling
 * app's direct socket call. Those never touch a Computer, so no governance
 * app has ever sat on their path — an app denied a tool call by the governor
 * could make the identical call over its peer socket and be obeyed.
 *
 * They do all converge: every one of them ends at `invokeExport()` in
 * rpc.ts. This is the check that runs there.
 *
 * ## Why this is not a dependency on @berth/agents
 *
 * A governor is a *resident app* in the same container, declaring `governs:
 * true` and exporting `evaluate_action` (both enforced by
 * @berth/manifest-schema). So asking it for a verdict is an ordinary
 * app-to-app RPC over the peer socket entrypoint.sh already provisions —
 * this file speaks the same line-delimited JSON as everything else here and
 * imports nothing from the agents package.
 *
 * ## Fail-closed, and what that costs
 *
 * A governor that is unreachable, slow, or crashed denies the call rather
 * than waving it through, matching the default @berth/agents adopted in
 * REMEDIATION.md 1.11: a policy check that did not happen must never quietly
 * become a policy check that passed.
 *
 * The blast radius here is genuinely larger than it is at the agent loop,
 * and that is worth stating rather than discovering. At the agent loop a
 * down governor fails *tool calls*. Here it fails *every app-to-app RPC in
 * the container*, including calls that have nothing to do with an agent.
 * What keeps that proportionate is that the gate only exists at all when a
 * governor is actually loaded: with no `BERTH_GOVERNANCE_APP` in the
 * environment — the common case, and every single-app container — this
 * module does nothing and costs one undefined check per request.
 */

/** How long a governor gets to answer before the call is refused. Matches @berth/agents' own evaluate_action timeout. */
const EVALUATE_TIMEOUT_MS = Number(process.env.BERTH_GOVERNANCE_TIMEOUT_MS || 5000);

export interface GateDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Who is asking. `caller` is the identity the kernel established — the peer
 * socket the request arrived on (rpc.ts's startPeerSocketServers explains why
 * that is a fact rather than a claim) — or one of the two non-sibling
 * channels, which are named rather than left blank so a governor can tell
 * them apart in its own policy:
 *
 *   "host"  — the relay (`berth rpc`, `berth mcp`, a Computer's own dispatch),
 *             which reaches this app's socket as root via `docker exec`
 *   "http"  — the HTTP RPC bridge, authenticated by its bearer token
 *   "tcp"   — the cross-container TCP listener (Crew.networked)
 */
export interface GateSubject {
  caller: string;
  export: string;
  input: unknown;
}

/** Reads the wiring entrypoint.sh exports. Read per call rather than cached at import so a test can set them around a single request. */
function gateConfig(): { governor: string; self: string } | null {
  const governor = process.env.BERTH_GOVERNANCE_APP;
  if (!governor) return null; // no governor in this container — the common case
  const self = process.env.BERTH_APP_NAME ?? "";
  // The governor's own exports are never gated: routing evaluate_action
  // through the gate would call evaluate_action to decide whether
  // evaluate_action may run. @berth/agents states the same rule at its own
  // dispatch; both are enforced, neither is inferred from a name lookup.
  if (self && self === governor) return null;
  // An app that declared `governance: { exempt: true }` in its manifest.
  // entrypoint.sh resolves the manifest field; this only reads the result.
  if (process.env.BERTH_GOVERNANCE_EXEMPT === "1") return null;
  return { governor, self };
}

/** True when a governor is loaded and this app is subject to it — lets callers skip building a subject at all. */
export function governanceGateActive(): boolean {
  return gateConfig() !== null;
}

/**
 * Asks the governor about one action. Returns null when no gate applies, so
 * the caller can tell "allowed" apart from "not governed" without either
 * being the default.
 */
export async function evaluateAction(subject: GateSubject): Promise<GateDecision | null> {
  const config = gateConfig();
  if (!config) return null;

  // BERTH_GOVERNANCE_SOCKET_ROOT is a test-only knob, in the same spirit as
  // github-api-broker.cjs's upstream overrides: it relocates the socket tree
  // so the gate's real dialling can be exercised without /run/berth. Unset in
  // every real container, where the path below is absolute.
  const socketPath = `${process.env.BERTH_GOVERNANCE_SOCKET_ROOT ?? ""}/run/berth/${config.governor}/peers/${config.self}/rpc.sock`;
  try {
    const verdict = await askGovernor(socketPath, {
      id: `gate-${process.pid}-${Date.now()}`,
      export: "evaluate_action",
      input: { app: config.self, export: subject.export, input: subject.input, caller: subject.caller },
    });
    if (verdict.allowed) return { allowed: true, reason: verdict.reason ?? "" };
    return { allowed: false, reason: verdict.reason ?? "denied by governance policy" };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    // Fail-closed. The distinction between "the governor said no" and "the
    // governor never answered" is kept in the message, because they call for
    // different operator responses — one is policy working, the other is
    // policy broken.
    console.error(`[berth:governance] evaluate_action unreachable for ${config.self}.${subject.export} (${cause}) — denying, fail-closed`);
    return { allowed: false, reason: `governance unavailable (${cause})` };
  }
}

/** One line-delimited JSON request over the governor's peer socket. No keep-alive: a governor verdict is a single round trip, and a pooled socket would outlive the governor's own restarts. */
function askGovernor(socketPath: string, request: { id: string; export: string; input: unknown }): Promise<{ allowed: boolean; reason?: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const finish = (err: Error | null, value?: { allowed: boolean; reason?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value!);
    };

    const timer = setTimeout(() => finish(new Error(`evaluate_action timed out after ${EVALUATE_TIMEOUT_MS}ms`)), EVALUATE_TIMEOUT_MS);

    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.error) {
          finish(new Error(String(response.error)));
          return;
        }
        const result = response.result;
        if (!result || typeof result.allowed !== "boolean") {
          // A governor that answers with something this can't read is a
          // governor that hasn't rendered a verdict — treated as unavailable,
          // not as consent.
          finish(new Error("evaluate_action returned no boolean 'allowed' field"));
          return;
        }
        finish(null, result);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on("error", (err) => finish(err));
    socket.on("close", () => finish(new Error("governor closed the connection without answering")));
  });
}
