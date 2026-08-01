import Docker from "dockerode";
import { PassThrough } from "node:stream";
import type { RpcRequest, RpcResponse } from "./relay.js";

export interface StdioRpcClient {
  call(request: RpcRequest): Promise<RpcResponse>;
  close(): void;
}

/**
 * Speaks the app runtime's line-delimited JSON RPC protocol directly over a
 * container's own stdio (container.attach()). This is how a single-app
 * `berth dev` container's app is reached — entrypoint.sh's single-app path
 * execs straight into the app's runtime as PID 1 and never sets up the
 * per-app Unix socket that only exists in multi-app mode (see relay.ts's
 * invokeAppExport, which targets that socket instead and needs
 * BERTH_APPS/docker exec — the wrong tool for a plain single-app dev
 * container). One attach connection is opened and reused for every call —
 * reattaching per call would tear down the container's actual stdin for
 * good, not just that viewer session.
 */
export async function createStdioRpcClient(container: Docker.Container, docker: Docker): Promise<StdioRpcClient> {
  const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);

  let buffer = "";
  const pending = new Map<string, (response: RpcResponse) => void>();

  stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as RpcResponse;
        pending.get(parsed.id)?.(parsed);
        pending.delete(parsed.id);
      } catch {
        // not a JSON RPC response line (e.g. a stray log line) — ignore
      }
    }
  });

  return {
    call(request: RpcRequest): Promise<RpcResponse> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reject(new Error(`timed out waiting for RPC response to ${JSON.stringify(request)}`));
        }, 30000);
        pending.set(request.id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        stream.write(JSON.stringify(request) + "\n");
      });
    },
    close() {
      stream.end();
    },
  };
}
