import * as readline from "node:readline";
import * as net from "node:net";
import { unlinkSync } from "node:fs";
import type { BerthApp } from "./app.js";

export interface RpcRequest {
  id: string;
  export: string;
  input?: unknown;
}

export type RpcResponse = { id: string; result: unknown } | { id: string; error: string };

/**
 * A minimal line-delimited JSON RPC server over stdin/stdout (and,
 * optionally, an additional Unix socket — see `socketPath` below). Each line
 * in is a { id, export, input } request; each line out is a { id, result }
 * or { id, error } response. This is what berth test's stub-payload
 * invocation (and, later, an agent's own tool-calling layer) talks to.
 *
 * `socketPath` is for multi-app-per-sandbox mode: only the container's PID 1
 * process has stdio reachable via `docker attach()` from the host, so
 * companion apps in the same container expose the identical line-JSON
 * framing over their own Unix socket instead — reached from the host via
 * `docker exec` + a tiny relay (see docker-orchestrator's relay.ts), not a
 * new wire format.
 *
 * `networkPort` (or the `BERTH_NETWORK_PORT` env var) binds that same framing
 * on a TCP listener instead of a Unix socket, reachable from *other*
 * containers on a shared Docker network (see @berth/agents's
 * Crew.networked()) rather than only from the host.
 */
export function startRpcServer(app: BerthApp, options?: { socketPath?: string; networkPort?: number }): void {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    if (!line.trim()) return;
    void handleFramedLine(app, line, (resp) => process.stdout.write(resp + "\n"));
  });

  console.error("[berth:runtime] RPC server listening on stdio");

  if (options?.socketPath) {
    startSocketServer(app, options.socketPath);
  }

  const networkPort = options?.networkPort ?? envNetworkPort();
  if (networkPort) {
    startTcpServer(app, networkPort);
  }
}

function envNetworkPort(): number | undefined {
  const raw = process.env.BERTH_NETWORK_PORT;
  return raw ? Number(raw) : undefined;
}

function connectionHandler(app: BerthApp): (socket: net.Socket) => void {
  return (socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        void handleFramedLine(app, line, (resp) => socket.write(resp + "\n"));
      }
    });
  };
}

function startSocketServer(app: BerthApp, socketPath: string): void {
  try {
    unlinkSync(socketPath);
  } catch {
    // fine if it didn't exist yet
  }

  const server = net.createServer(connectionHandler(app));
  server.listen(socketPath, () => {
    console.error(`[berth:runtime] RPC server also listening on ${socketPath}`);
  });
}

function startTcpServer(app: BerthApp, port: number): void {
  const server = net.createServer(connectionHandler(app));
  server.listen(port, "0.0.0.0", () => {
    console.error(`[berth:runtime] RPC server also listening on 0.0.0.0:${port}`);
  });
}

async function handleFramedLine(app: BerthApp, line: string, write: (encodedResponse: string) => void): Promise<void> {
  let request: RpcRequest;
  try {
    request = JSON.parse(line);
  } catch {
    console.error(`[berth:runtime] ignoring non-JSON RPC line: ${line}`);
    return;
  }

  const response = await invokeExport(app, request);
  write(JSON.stringify(response));
}

export async function invokeExport(app: BerthApp, request: RpcRequest): Promise<RpcResponse> {
  const exportDef = app._exports.get(request.export);
  if (!exportDef) {
    return { id: request.id, error: `no such export "${request.export}"` };
  }

  try {
    const input = exportDef.input ? exportDef.input.parse(request.input) : request.input;
    const rawResult = await exportDef.handler(input);
    // Send the *parsed* result, not the handler's raw return value — a Zod
    // schema with `.default(...)`/transforms can produce a value that
    // differs from what the handler returned, and the wire response must
    // reflect that (not just validate it), or two exports with identical
    // output schemas serialize differently depending on which SDK
    // implements them. rpc.py's invoke_export() already does this by
    // re-serializing through its Pydantic model.
    const result = exportDef.output ? exportDef.output.parse(rawResult) : rawResult;
    return { id: request.id, result };
  } catch (err) {
    return { id: request.id, error: err instanceof Error ? err.message : String(err) };
  }
}
