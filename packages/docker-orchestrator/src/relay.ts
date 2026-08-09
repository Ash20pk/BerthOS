import Docker from "dockerode";
import { PassThrough } from "node:stream";

/**
 * Parent of the per-app socket directories, not a directory sockets sit in
 * directly. Each app binds /run/berth/<app>/rpc.sock in a directory mode 0710
 * and owned by that app's own uid, which is what stops a sibling reaching it
 * (REMEDIATION.md 1.4). This used to be /tmp/berth-rpc, mode 1777.
 *
 * The relay below is unaffected by that: `docker exec` enters as root, and
 * root traverses a 0710 directory regardless of owner. That asymmetry is
 * deliberate and documented — the uid boundary is between apps, never between
 * the host and an app (docs/per-app-uid-design.md § Blocker 7).
 */
export const RPC_SOCKET_DIR = "/run/berth";

export function rpcSocketPathFor(appName: string): string {
  return `${RPC_SOCKET_DIR}/${appName}/rpc.sock`;
}

export interface RpcRequest {
  id: string;
  export: string;
  input?: unknown;
}
export type RpcResponse = { id: string; result?: unknown; error?: string };

/**
 * Reaches one companion app's RPC socket in a multi-app-per-sandbox
 * container from the host. `container.attach()` can only reach the
 * container's own PID 1 stdio — there's no Docker Engine API to attach to
 * an arbitrary interior process — so this spawns a tiny relay process
 * inside the container via `docker exec` (see docker/rpc-relay.js) that
 * pipes its own stdio to the target app's Unix socket, and speaks the exact
 * same line-delimited JSON framing `@berth/sdk`'s rpc.ts already uses over
 * stdio. Only the transport is new; the wire format doesn't change.
 */
export async function invokeAppExport(
  container: Docker.Container,
  appName: string,
  request: RpcRequest,
  opts?: { docker?: Docker; timeoutMs?: number },
): Promise<RpcResponse> {
  const docker = opts?.docker ?? new Docker();
  const timeoutMs = opts?.timeoutMs ?? 5000;

  const exec = await container.exec({
    Cmd: ["node", "/usr/local/bin/berth-rpc-relay.js", rpcSocketPathFor(appName)],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: true });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);

  let stderrText = "";
  stderr.on("data", (chunk: Buffer) => (stderrText += chunk.toString("utf-8")));

  return new Promise<RpcResponse>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      stream.end();
      reject(new Error(`invokeAppExport("${appName}", "${request.export}") timed out after ${timeoutMs}ms${stderrText ? `: ${stderrText}` : ""}`));
    }, timeoutMs);

    stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(line) as RpcResponse);
        } catch (err) {
          reject(new Error(`invokeAppExport: could not parse response line "${line}": ${err}`));
        }
        stream.end();
        return;
      }
    });

    stream.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });

    stream.write(JSON.stringify(request) + "\n");
  });
}
