import type { RpcRequest, RpcResponse, StdioRpcCallOptions } from "@berthos/docker-orchestrator";
import type { BerthManifest } from "@berthos/manifest-schema";
import type { EnforcementStatus } from "./capability-errors.js";
import type { RunAudit } from "./run-audit.js";

/**
 * One `berth mcp` tool call, from the MCP client's arguments to the result it
 * gets back, with an audit record for every way it can end. Pulled out of
 * commands/mcp.ts so each of those ways can be tested without a sandbox.
 *
 * The ways it ends: the app answers with a result (allowed), with an error
 * the sandbox caused (denied) or one it didn't (allowed, failed), or never
 * answers at all: the RPC times out, the write to the sandbox fails, or the
 * session ends while it's in flight. That last group used to leave no
 * record at all, although the request may well have reached the app and run.
 */

export type ToolResult = { isError?: boolean; content: { type: "text"; text: string }[] };

export interface ToolCallContext {
  export: string;
  /** Sends the request to the app. */
  call: (request: RpcRequest, options: StdioRpcCallOptions) => Promise<RpcResponse>;
  /** Turns an app error into what the agent reads (capability-errors.ts's explainAppError). */
  explain: (error: string) => string;
  /**
   * Whether this export may report refusals inside a successful call: true
   * only when its berth.yml output declares `denials` (code-interpreter's
   * run_code does). Any other app's `denials` field is ignored, since what
   * the bridge does with one is tell the agent the sandbox refused something.
   */
  reportsDenials?: boolean;
  /** The note added after a successful result that reports possible refusals. Omitted: no note. */
  describeReportedDenials?: (denials: ReportedDenial[]) => string;
  runAudit?: RunAudit;
  /** The bridge's own wait for a response, before any per-call allowance (rpcTimeoutFor). */
  callTimeoutMs: number;
  inFlight: InFlightCalls;
}

/** Headroom over a call's own `timeout_ms`, for the app to kill the work and answer. */
export const TIMEOUT_MS_GRACE = 15_000;

/**
 * How long to wait for one call's response. An export that takes a
 * `timeout_ms` (code-interpreter's run_code accepts up to 60 s) is asking to
 * run that long, and a bridge that gave up at a fixed 30 s reported a
 * working call as a failure while it was still running.
 */
export function rpcTimeoutFor(args: Record<string, unknown>, callTimeoutMs: number): number {
  const own = args.timeout_ms;
  if (typeof own === "number" && Number.isFinite(own) && own > 0) return Math.max(callTimeoutMs, own + TIMEOUT_MS_GRACE);
  return callTimeoutMs;
}

export async function handleToolCall(ctx: ToolCallContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  // Nothing sent, so nothing ran and there's nothing to record.
  if (signal?.aborted) return { isError: true, content: [{ type: "text", text: `"${ctx.export}" was cancelled by the client before it was sent` }] };
  const startedAt = Date.now();
  const request: RpcRequest = { id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`, export: ctx.export, input: args };
  const done = ctx.inFlight.start({ export: ctx.export, input: args, startedAt });

  let response: RpcResponse;
  try {
    response = await ctx.call(request, { timeoutMs: rpcTimeoutFor(args, ctx.callTimeoutMs), ...(signal ? { signal } : {}) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (done()) {
      await ctx.runAudit?.toolCall({ export: ctx.export, input: args, durationMs: Date.now() - startedAt, unanswered: { reason } });
    }
    return {
      isError: true,
      content: [{ type: "text", text: `no answer from "${ctx.export}": ${reason}. The request may have reached the app, so it may have run — check before retrying anything that isn't safe to repeat.` }],
    };
  }
  // Recorded by the shutdown path already if the session ended first.
  if (!done()) return resultFor(ctx, response);

  if (response.error) {
    const explained = ctx.explain(response.error);
    await ctx.runAudit?.toolCall({
      export: ctx.export,
      input: args,
      durationMs: Date.now() - startedAt,
      error: response.error,
      denied: explained.startsWith("BERTH CAPABILITY DENIAL"),
    });
    return { isError: true, content: [{ type: "text", text: explained }] };
  }
  const denials = ctx.reportsDenials ? reportedDenials(response.result) : [];
  await ctx.runAudit?.toolCall({
    export: ctx.export,
    input: args,
    durationMs: Date.now() - startedAt,
    result: response.result,
    ...(denials.length > 0 ? { reportedDeniedPaths: denials.map((d) => d.path) } : {}),
  });
  const result = resultFor(ctx, response);
  if (denials.length > 0 && ctx.describeReportedDenials) result.content.push({ type: "text", text: ctx.describeReportedDenials(denials) });
  return result;
}

/** A possible refusal inside a successful call, as the app reported it. */
export interface ReportedDenial {
  path: string;
  line: string;
}

export const MAX_REPORTED_DENIALS = 10;
const MAX_REPORTED_CHARS = 200;

function clean(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_REPORTED_CHARS);
}

/**
 * An app's own report of possible refusals inside a successful call
 * (code-interpreter's `denials`: [{ path, line }]), taken only in that
 * shape. Entries that aren't an absolute path with a line are dropped, text
 * is stripped of control characters and cut to 200 characters, and at most
 * ten are kept: this is the app's text, and it ends up in front of an agent.
 */
export function reportedDenials(result: unknown): ReportedDenial[] {
  const denials = (result as { denials?: unknown } | null | undefined)?.denials;
  if (!Array.isArray(denials)) return [];
  const out: ReportedDenial[] = [];
  for (const entry of denials) {
    const { path, line } = (entry ?? {}) as { path?: unknown; line?: unknown };
    if (typeof path !== "string" || typeof line !== "string" || !path.startsWith("/")) continue;
    out.push({ path: clean(path), line: clean(line) });
    if (out.length === MAX_REPORTED_DENIALS) break;
  }
  return out;
}

/**
 * Whether an export may report refusals inside a successful call: its
 * berth.yml output declares `denials` (code-interpreter's run_code does).
 * An app that doesn't declare it can still return a `denials` field, and it
 * is passed through as data but never turned into a note about the sandbox.
 */
export function exportReportsDenials(manifest: BerthManifest, exportName: string): boolean {
  return manifest.exports.find((e) => e.name === exportName)?.output?.denials === "array";
}

/**
 * The note after a result that reports possible refusals. The code handled
 * the error, so nothing else tells the agent that it may have been Berth
 * rather than a bug. Worded as the app's report, not the bridge's: the
 * bridge never saw these refusals happen, only the app's reading of its own
 * output. Deliberately not headed BERTH CAPABILITY DENIAL, which the bridge
 * uses for a refusal it knows about (capability-errors.ts).
 */
export function describeReportedDenials(manifest: BerthManifest, enforcement: EnforcementStatus, denials: ReportedDenial[]): string {
  return [
    `POSSIBLE SANDBOX REFUSAL (reported by ${manifest.name}, inside a call that succeeded)`,
    ...denials.map((d) => `reported: ${d.path} — ${JSON.stringify(d.line)}`),
    `source: lines of the call's own output that ${manifest.name} picked out as permission errors; the bridge did not observe these refusals`,
    `enforcement in this container: ${enforcement === "enforced" ? "the kernel (Landlock/seccomp) is enforcing the app's declared capabilities" : enforcement}`,
    `declared: ${manifest.capabilities.join(", ") || "(none)"}`,
    `if it was the sandbox: the path is outside what the app declares, and the same operation will be refused again`,
  ].join("\n");
}

function resultFor(ctx: ToolCallContext, response: RpcResponse): ToolResult {
  if (response.error) return { isError: true, content: [{ type: "text", text: ctx.explain(response.error) }] };
  return { content: [{ type: "text", text: JSON.stringify(response.result ?? null) }] };
}

interface InFlightCall {
  export: string;
  input: unknown;
  startedAt: number;
}

/**
 * The calls sent to the app and not yet answered. When the session ends with
 * some still out, each is recorded as interrupted rather than dropped: the
 * process is about to exit, and a call it never heard back from is exactly
 * the one an auditor needs to know about.
 */
export interface InFlightCalls {
  /** Marks a call in flight. The returned function takes it back out, and says whether it was still there (false once interrupted). */
  start(call: InFlightCall): () => boolean;
  /** Records every call still in flight as interrupted, once, and forgets them. */
  interruptAll(runAudit: RunAudit | undefined): Promise<void>;
  readonly size: number;
}

export function createInFlightCalls(): InFlightCalls {
  const calls = new Set<InFlightCall>();
  return {
    start(call) {
      calls.add(call);
      return () => calls.delete(call);
    },
    async interruptAll(runAudit) {
      const interrupted = [...calls];
      calls.clear();
      for (const call of interrupted) {
        await runAudit?.toolCall({
          export: call.export,
          input: call.input,
          durationMs: Date.now() - call.startedAt,
          unanswered: { reason: "the session ended", interrupted: true },
        });
      }
    },
    get size() {
      return calls.size;
    },
  };
}

export interface ShutdownOptions {
  /** Audit writes to finish before the sandbox goes: the boot evidence can only be read from a running one. */
  pending: () => Promise<void>;
  /** Longest to wait for `pending`. */
  pendingTimeoutMs: number;
  /** Records calls still in flight. */
  interrupt: () => Promise<void>;
  /** Stops the sandbox, when this session owns it. */
  stop?: () => Promise<void>;
  exit: () => void;
}

/**
 * The bridge's teardown, run once however it is triggered (a signal, the
 * transport closing, stdin ending): let pending audit writes land, record
 * what's still in flight, stop a sandbox this session owns, exit.
 *
 * `{ urgent: true }` (a signal) skips, or cuts short, the wait for pending
 * writes. MCP clients close the pipe, then send SIGTERM and SIGKILL within
 * seconds; a SIGTERM is the last notice before a kill that would leave the
 * sandbox running, so stopping it comes before finishing a record.
 */
export function createShutdown(options: ShutdownOptions): (trigger?: { urgent?: boolean }) => Promise<void> {
  let running: Promise<void> | undefined;
  let hurry: () => void = () => {};
  let urgent = false;
  const hurried = new Promise<void>((resolve) => (hurry = resolve));
  return (trigger = {}) => {
    if (trigger.urgent) {
      urgent = true;
      hurry();
    }
    running ??= (async () => {
      if (!urgent) await withTimeout(Promise.race([options.pending().catch(() => {}), hurried]), options.pendingTimeoutMs);
      await options.interrupt().catch(() => {});
      await options.stop?.().catch(() => {});
      options.exit();
    })();
    return running;
  };
}

/**
 * Not unref'd: during shutdown this timer may be the only thing keeping the
 * process alive, and letting it exit early would skip stopping the sandbox.
 * Cleared as soon as the promise settles, so it never holds the process open
 * past that.
 */
export function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]).finally(() => clearTimeout(timer));
}
