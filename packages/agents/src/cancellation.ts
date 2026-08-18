/**
 * Cancellation plumbing for the agent loop — REMEDIATION 4.2.
 *
 * Before this there was no `AbortSignal` anywhere in either package: no way
 * to stop a run, no per-tool timeout, no wall-clock deadline, and nothing but
 * `maxTurns` bounding how long `run()` could take. A closed browser tab kept
 * burning tokens because `server.ts` never listened for a disconnect, and a
 * hung tool call blocked the loop forever because `agent.ts` awaited it
 * unbounded.
 *
 * Kept in its own module because the composition rules below are subtle
 * enough to want testing directly, and because `agent.ts` is already long.
 */

import { RunAbortedError, RunTimeoutError, ToolTimeoutError } from "./errors.js";

/**
 * The signals governing one run.
 *
 * `dispose()` must be called when the run ends, however it ends — the
 * deadline is a real `setTimeout`, and leaving it pending would hold the
 * process open for the remainder of a timeout the run already beat.
 *
 * **Why a plain `setTimeout` rather than `AbortSignal.timeout()`**, which is
 * the obvious primitive and was the first implementation here: its timer is
 * unref'd. A run whose only pending work is that deadline therefore doesn't
 * keep the event loop alive, so Node exits before it can fire — the run ends
 * by the process quietly going away instead of by raising RunTimeoutError.
 * That is precisely backwards for a feature whose job is to convert a hang
 * into a legible error. Found by the tool-timeout test dying with "Promise
 * resolution is still pending but the event loop has already resolved",
 * which is what that failure mode looks like from the outside.
 */
export interface RunCancellation {
  /** Passed to every LLM call and tool invocation in the run. Undefined when the run has neither a caller signal nor a deadline, so nothing pays for a feature it didn't ask for. */
  readonly signal: AbortSignal | undefined;
  /** Throws RunTimeoutError or RunAbortedError if the run should stop now; returns otherwise. Called at each loop boundary. */
  throwIfCancelled(): void;
  /** Clears the deadline timer and detaches the listener on the caller's signal. Safe to call more than once. */
  dispose(): void;
}

const NO_CANCELLATION: RunCancellation = {
  signal: undefined,
  throwIfCancelled() {},
  dispose() {},
};

/**
 * Builds the cancellation state for one run from a caller's signal and an
 * optional wall-clock deadline.
 *
 * The two are kept as separate references rather than merged into one, even
 * though `AbortSignal.any()` produces a single signal to hand downstream.
 * That's what makes `throwIfCancelled()` able to say *which* happened —
 * merged, both a caller's `abort()` and an elapsed deadline arrive as an
 * indistinguishable "aborted", and the caller gets told "you cancelled this"
 * about a run that actually timed out.
 */
export function createRunCancellation(
  agentName: string,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): RunCancellation {
  if (!callerSignal && timeoutMs === undefined) return NO_CANCELLATION;

  const controller = new AbortController();
  let timedOut = false;

  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort(new RunTimeoutError(agentName, timeoutMs));
        }, timeoutMs);

  const onCallerAbort = () => controller.abort(callerSignal!.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  return {
    signal: controller.signal,
    throwIfCancelled() {
      // Deadline first: if both fired, the deadline is the more specific
      // explanation, and a caller aborting *because* a run is overrunning is
      // a common enough race to be worth resolving in that direction.
      if (timedOut) throw new RunTimeoutError(agentName, timeoutMs!);
      if (controller.signal.aborted) throw new RunAbortedError(agentName);
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/**
 * Races a tool call against its own timeout and the run's cancellation.
 *
 * The tool gets the composed signal, so a tool that honours it can clean up
 * after itself. But the race does not *wait* for it to: a tool that ignores
 * the signal entirely — which is every tool written before 4.2, including
 * every resident-app export — would otherwise hang the loop exactly as
 * before, making the timeout decorative. So the returned promise settles on
 * the timer regardless, and a tool that keeps running after that point runs
 * detached, with its eventual result discarded.
 *
 * That detachment is the honest cost of bounding calls into code that
 * predates the signal, and it is stated in the docs rather than hidden: the
 * timeout bounds *how long the loop waits*, not how long the tool runs. For
 * a resident-app export the call is an RPC into a sandboxed process, so the
 * work does eventually finish or die with the Computer.
 */
export async function withToolTimeout<T>(
  toolName: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  call: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  // Raced even with no per-tool timeout set, whenever the run itself is
  // cancellable. Without this, `abort()` and the wall-clock deadline cannot
  // interrupt a tool that ignores its signal — which is every tool written
  // before 4.2 — so the one case the feature exists for, a call that hangs,
  // is the one case it couldn't stop. The loop stops waiting; the call
  // itself runs on detached, as documented above.
  if (timeoutMs === undefined && !signal) return call(signal);

  const controller = new AbortController();
  const onRunAbort = () => controller.abort(signal!.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onRunAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(controller.signal),
      new Promise<never>((_resolve, reject) => {
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            const err = new ToolTimeoutError(toolName, timeoutMs);
            // Abort first, so a tool that *does* honour its signal gets the
            // chance to stop and clean up, then reject regardless — see the
            // note above on why the race can't wait for it.
            controller.abort(err);
            reject(err);
          }, timeoutMs);
        }
        // The run's own cancellation loses the race the same way, rejecting
        // with whatever reason it carries (RunAbortedError, RunTimeoutError,
        // or a caller's own) so the loop above can tell which happened.
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ]);
  } finally {
    // A ref'd timer, so it has to be cleared on the winning path too —
    // otherwise every fast tool call leaves the process alive for the length
    // of a timeout it never came near.
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onRunAbort);
  }
}

/**
 * An AbortController that fires when the HTTP client goes away.
 *
 * `"close"` on the *request* is the event that covers both halves of the
 * problem — a client that hangs up mid-run, and one whose connection drops —
 * and it fires on normal completion too, which is harmless: by then the run
 * has already resolved and aborting a finished run is a no-op.
 *
 * `dispose()` matters here in a way it didn't for `RunCancellation`: without
 * removing the listener, every request against a keep-alive server leaves one
 * attached to a socket that outlives it.
 */
export function abortOnClientDisconnect(req: { on(event: "close", cb: () => void): unknown; off(event: "close", cb: () => void): unknown }): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  req.on("close", onClose);
  return {
    signal: controller.signal,
    dispose: () => {
      req.off("close", onClose);
    },
  };
}

/** A `setTimeout` that also settles when `signal` fires, so a poll loop doesn't sit through its full interval after being cancelled. Rejects with the signal's own reason, so it reads as a cancellation rather than as a timer failure. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
