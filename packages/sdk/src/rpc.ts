import * as readline from "node:readline";
import * as net from "node:net";
import { chmodSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * Alongside `socketPath` this also binds one socket per *authorized sibling*,
 * discovered by reading `<socketPath's directory>/peers/` — see
 * startPeerSocketServers() for why the caller's identity comes from which
 * socket it reached rather than from anything it says.
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
    startPeerSocketServers(app, options.socketPath);
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

/**
 * `peer` is who the kernel let through to this listener, not who the caller
 * says it is — see startPeerSocketServers(). `undefined` means a channel where
 * only root and this app itself can reach us (stdio, the relay's socket).
 */
function connectionHandler(app: BerthApp, peer?: string): (socket: net.Socket) => void {
  return (socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        void handleFramedLine(app, line, (resp) => socket.write(resp + "\n"), peer);
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
    // 0600, explicitly, rather than whatever the umask leaves behind. This
    // socket is for the host relay (`docker exec`, root, which mode bits don't
    // constrain) and for this app itself. No sibling reaches it: an authorized
    // one gets its own socket under peers/, so that the server can tell who is
    // calling — see startPeerSocketServers().
    try {
      chmodSync(socketPath, 0o600);
    } catch (err) {
      console.error(`[berth:runtime] WARNING: could not chmod ${socketPath} to 0600 (${err})`);
    }
    console.error(`[berth:runtime] RPC server also listening on ${socketPath}`);
  });
}

/**
 * One listener per sibling app that declared `app:invoke:<this app>`.
 *
 * This is how the server learns *which* app is calling it, and the mechanism
 * is the filesystem rather than the socket: `entrypoint.sh` creates
 * `/run/berth/<this app>/peers/<caller>/` mode `2710`, owned by this app and
 * group-owned by the *caller*, so the caller is the only unprivileged uid that
 * can traverse into it. The connection's arrival on that socket is therefore
 * the kernel's statement about who connected, checked by DAC at `connect(2)`,
 * and nothing the caller sends can change it.
 *
 * The obvious implementation is `SO_PEERCRED`, which is what the two daemons
 * in this repo use (context-bus-daemon's `src/peer.rs`, semantic-fs-daemon's
 * `internal/control/peer.go`) and what docs/per-app-uid-design.md's Step 4
 * specified. Node exposes no `getsockopt` and no way to read ancillary
 * credentials on a Unix socket, so it is not available here without a native
 * addon — which this SDK is vendored into images as a tarball and has no
 * build step for. A directory per caller gets the same property from the same
 * kernel check, one layer up.
 *
 * The peers directory is *read*, not configured: `entrypoint.sh` creates it in
 * a pass that finishes before any app process starts, so what is on disk at
 * this moment is exactly the authorized set. There is no env var to keep in
 * sync, and an app with no callers simply finds nothing.
 *
 * The setgid bit on each directory is what makes the socket below land in the
 * caller's group without this process — which is not root — having to chown
 * anything.
 */
function startPeerSocketServers(app: BerthApp, socketPath: string): void {
  const peersDir = join(dirname(socketPath), "peers");
  let callers: string[];
  try {
    callers = readdirSync(peersDir);
  } catch {
    return; // no authorized callers, which is the common case
  }

  for (const caller of callers) {
    const peerSocketPath = join(peersDir, caller, "rpc.sock");
    try {
      unlinkSync(peerSocketPath);
    } catch {
      // fine if it didn't exist yet
    }
    const server = net.createServer(connectionHandler(app, caller));
    server.on("error", (err) => {
      console.error(`[berth:runtime] WARNING: could not serve ${caller} on ${peerSocketPath} (${err}) — its app:invoke: calls will fail`);
    });
    server.listen(peerSocketPath, () => {
      // 0660 so the caller's group can connect; the umask default of 0755
      // leaves group r-x, and connecting to a pathname socket needs write.
      try {
        chmodSync(peerSocketPath, 0o660);
      } catch (err) {
        console.error(`[berth:runtime] WARNING: could not chmod ${peerSocketPath} to 0660 (${err}) — ${caller} will get EACCES`);
      }
      console.error(`[berth:runtime] RPC server also listening on ${peerSocketPath} for "${caller}"`);
    });
  }
}

function startTcpServer(app: BerthApp, port: number): void {
  const server = net.createServer(connectionHandler(app));
  server.listen(port, "0.0.0.0", () => {
    console.error(`[berth:runtime] RPC server also listening on 0.0.0.0:${port}`);
  });
}

async function handleFramedLine(app: BerthApp, line: string, write: (encodedResponse: string) => void, peer?: string): Promise<void> {
  let request: RpcRequest;
  try {
    request = JSON.parse(line);
  } catch {
    console.error(`[berth:runtime] ignoring non-JSON RPC line: ${line}`);
    return;
  }

  // One audit line per cross-app call, and only for those: an app's own stdio
  // and the host relay are not siblings and would only add noise. This is the
  // record that says *which* app invoked an export, which until per-peer
  // sockets existed could not be known at all (REMEDIATION.md 1.4, 1.14).
  if (peer) {
    console.error(`[berth:runtime] "${peer}" invoked export "${request.export}"`);
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
