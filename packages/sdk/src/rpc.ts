import * as readline from "node:readline";
import type { BerthApp } from "./app.js";

interface RpcRequest {
  id: string;
  export: string;
  input?: unknown;
}

type RpcResponse = { id: string; result: unknown } | { id: string; error: string };

/**
 * A minimal line-delimited JSON RPC server over stdin/stdout. Each line in is
 * a { id, export, input } request; each line out is a { id, result } or
 * { id, error } response. This is what berth test's stub-payload invocation
 * (and, later, an agent's own tool-calling layer) talks to.
 */
export function startRpcServer(app: BerthApp): void {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    if (!line.trim()) return;
    void handleLine(app, line);
  });

  console.error("[berth:runtime] RPC server listening on stdio");
}

async function handleLine(app: BerthApp, line: string): Promise<void> {
  let request: RpcRequest;
  try {
    request = JSON.parse(line);
  } catch {
    console.error(`[berth:runtime] ignoring non-JSON line on RPC stdin: ${line}`);
    return;
  }

  const response = await invokeExport(app, request);
  process.stdout.write(JSON.stringify(response) + "\n");
}

export async function invokeExport(app: BerthApp, request: RpcRequest): Promise<RpcResponse> {
  const exportDef = app._exports.get(request.export);
  if (!exportDef) {
    return { id: request.id, error: `no such export "${request.export}"` };
  }

  try {
    const input = exportDef.input ? exportDef.input.parse(request.input) : request.input;
    const result = await exportDef.handler(input);
    if (exportDef.output) {
      exportDef.output.parse(result);
    }
    return { id: request.id, result };
  } catch (err) {
    return { id: request.id, error: err instanceof Error ? err.message : String(err) };
  }
}
