import Docker from "dockerode";
import { PassThrough, type Duplex } from "node:stream";
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
  const pending = new Map<string, (response: RpcResponse) => void>();
  let stream = await attachStream(container, docker, pending);
  let closedByCaller = false;

  /**
   * A Docker attach connection is not guaranteed to outlive the container it
   * is attached to, and when it goes the failure is invisible: writes to the
   * dead stream are silently dropped and every call sits out its full 30s
   * timeout with a message that blames the app. Observed directly — a stream
   * whose read side had already ended while the container, and the app inside
   * it, were both perfectly healthy and answering a freshly attached client.
   *
   * So the stream is treated as replaceable rather than permanent. Reattaching
   * is safe in a way that *re*-attaching per call would not be: the warning in
   * this file's header is about calling end() on a live attach, which really
   * does tear down the container's stdin for good. This only ever runs when
   * the stream is already gone.
   */
  async function liveStream(): Promise<Duplex> {
    if (!closedByCaller && (stream.destroyed || stream.readableEnded)) {
      stream = await attachStream(container, docker, pending);
    }
    return stream;
  }

  return {
    async call(request: RpcRequest): Promise<RpcResponse> {
      const target = await liveStream();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reject(new Error(`timed out waiting for RPC response to ${JSON.stringify(request)}`));
        }, 30000);
        pending.set(request.id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        // Reported rather than ignored: a false here means the write was
        // dropped, which used to be indistinguishable from an app that never
        // answered.
        if (!target.write(JSON.stringify(request) + "\n")) {
          clearTimeout(timer);
          pending.delete(request.id);
          reject(new Error(`could not write ${JSON.stringify(request)} to the container's stdin — the attach stream is not accepting writes`));
        }
      });
    },
    close() {
      closedByCaller = true;
      stream.end();
    },
  };
}

/**
 * One attach connection, wired to a shared `pending` map so that a replacement
 * stream resolves calls the same way the original did.
 */
async function attachStream(container: Docker.Container, docker: Docker, pending: Map<string, (response: RpcResponse) => void>): Promise<Duplex> {
  const stream = (await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true })) as Duplex;

  // The first thing written to a freshly attached container's stdin is not
  // ours, and this newline is what stops it corrupting the first RPC call.
  //
  // attach is a POST, and docker-modem's dial() does
  // `data = JSON.stringify(opts._body || opts)` for *every* POST — so the
  // attach options object itself is sent as the request body, with no
  // trailing newline. Once the connection upgrades, those bytes are the first
  // thing on the container's stdin, and the app's runtime reads
  // `{"stream":true,...}{"id":"1","export":...}` as a single line and discards
  // it as unparseable. The call then times out having never been seen.
  //
  // Confirmed by reading the app's own log inside a running container, which
  // shows exactly that concatenated line. Writing a newline here terminates
  // the stray body as its own line, so the first real request starts clean.
  // (`_body: {}` looks like the tidier fix, but it makes docker-modem send a
  // chunked request with no body and the attach then never completes at all —
  // tried, and the container hangs at startup.)
  //
  // python-sdk-milestone.mjs found this and worked around it for itself; every
  // other attach site in this repo, including this one — the client
  // Computer.boot() uses for every single-app container — was silently paying
  // for it, which is the most likely explanation for the intermittent "first
  // RPC call timed out" failures seen across these tests.
  stream.write("\n");

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);

  let buffer = "";
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

  // Without this, an error on the socket is an unhandled "error" event, which
  // Node turns into an uncaught exception in whatever process is driving the
  // container.
  stream.on("error", () => {});

  return stream;
}
