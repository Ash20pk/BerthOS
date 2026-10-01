/**
 * Opt-in phase timing for the local boot path, read by
 * scripts/bench/local-boot.mjs.
 *
 * With BERTH_TIMING=1 each phase writes one line to stderr:
 *
 *   [berth:timing] phase=<name> ms=<duration> t=<epoch ms at the end>
 *
 * Unset, nothing is written. stderr, not stdout, because `berth mcp`'s stdout
 * is its MCP transport.
 */
export function timingEnabled(): boolean {
  return process.env.BERTH_TIMING === "1";
}

/**
 * A stopwatch for consecutive phases: each call reports the time since the
 * previous one (or since the stopwatch was made) under the given name.
 */
export function phaseTimer(): (phase: string) => void {
  let last = Date.now();
  return (phase) => {
    const now = Date.now();
    if (timingEnabled()) process.stderr.write(`[berth:timing] phase=${phase} ms=${now - last} t=${now}\n`);
    last = now;
  };
}
