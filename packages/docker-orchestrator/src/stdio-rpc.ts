import Docker from "dockerode";
import { PassThrough, type Duplex } from "node:stream";
import type { RpcRequest, RpcResponse } from "./relay.js";

export interface StdioRpcCallOptions {
  /** How long to wait for the response. Default 30s. A call that runs longer than this on purpose (code with its own timeout) needs more. */
  timeoutMs?: number;
  /** Stop waiting when this aborts. The request has already been written, so the app may still run it. */
  signal?: AbortSignal;
}

export const DEFAULT_STDIO_RPC_TIMEOUT_MS = 30_000;

/**
 * A call given up on before its request was written: the app never saw it,
 * so unlike every other failure of call() it certainly did not run.
 */
export class RpcNotSentError extends Error {
  override name = "RpcNotSentError";
}

export interface StdioRpcClient {
  call(request: RpcRequest, options?: StdioRpcCallOptions): Promise<RpcResponse>;
  close(): void;
}

/**
 * One connection a line-RPC client can write requests to. `open` is false
 * once it can no longer carry a request (its peer went away, or it was
 * closed), and the client then opens another.
 */
export interface LineRpcConnection {
  write(line: string): boolean;
  open(): boolean;
  close(): void;
}

export interface LineRpcClientOptions {
  /**
   * Opens a connection. Every response line read from it goes to `onLine`;
   * `onClose` is called once when it stops carrying responses.
   */
  connect(onLine: (line: string) => void, onClose: () => void): Promise<LineRpcConnection>;
  /** Names what a request is written to, for the could-not-write error: "the container's stdin". */
  target: string;
  /**
   * Fail the calls still waiting when their connection closes, instead of
   * letting each sit out its timeout. Right for a socket, where a close means
   * no answer can come on it. Docker's attach stream is kept on the old
   * behaviour: its read side has been seen to end while the app was fine.
   */
  failPendingOnClose?: boolean;
}

/**
 * The SDK's line-delimited JSON RPC (`{"id","export","input"}` in,
 * `{"id","result"}` or `{"id","error"}` out) over a replaceable connection.
 * Shared by the Docker attach client below and the microVM's vsock-mapped
 * sockets (berth CLI, local-vm runtime). A response line that isn't JSON, or
 * answers no pending call, is ignored.
 */
export async function createLineRpcClient(options: LineRpcClientOptions): Promise<StdioRpcClient> {
  type Waiter = { resolve: (response: RpcResponse) => void; fail: (err: Error) => void; conn: LineRpcConnection };
  const pending = new Map<string, Waiter>();
  let closedByCaller = false;

  const open = async (): Promise<LineRpcConnection> => {
    let conn: LineRpcConnection | undefined;
    const closed = () => {
      if (!options.failPendingOnClose) return;
      for (const [id, waiter] of pending) {
        if (waiter.conn !== conn) continue;
        pending.delete(id);
        waiter.fail(new Error("the connection closed before the app answered"));
      }
    };
    conn = await options.connect((line) => {
      if (!line.trim()) return;
      let parsed: RpcResponse;
      try {
        parsed = JSON.parse(line) as RpcResponse;
      } catch {
        // not a JSON RPC response line (e.g. a stray log line) — ignore
        return;
      }
      if (typeof parsed !== "object" || parsed === null || typeof parsed.id !== "string") return;
      const waiter = pending.get(parsed.id);
      pending.delete(parsed.id);
      waiter?.resolve(parsed);
    }, closed);
    return conn;
  };
  let conn = await open();

  async function live(): Promise<LineRpcConnection> {
    if (!closedByCaller && !conn.open()) conn = await open();
    return conn;
  }

  return {
    async call(request: RpcRequest, callOptions: StdioRpcCallOptions = {}): Promise<RpcResponse> {
      const { timeoutMs = DEFAULT_STDIO_RPC_TIMEOUT_MS, signal } = callOptions;
      // Errors name the export and the request id, never the request itself:
      // callers record these messages (berth mcp's audit `reason`), and the
      // request's input is the agent's arguments — file contents, code,
      // secrets.
      const which = `${request.export} (request ${request.id})`;
      const notSent = () => new RpcNotSentError(`not sent: the caller gave up on ${which} before it was written`);
      if (signal?.aborted) throw notSent();
      const target = await live();
      // Checked again: reconnecting above can take long enough to be given up on.
      if (signal?.aborted) throw notSent();
      return new Promise((resolve, reject) => {
        const settle = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          pending.delete(request.id);
        };
        const onAbort = () => {
          settle();
          reject(new Error(`the caller gave up waiting for the response to ${which}`));
        };
        const timer = setTimeout(() => {
          settle();
          reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the response to ${which}`));
        }, timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        pending.set(request.id, {
          conn: target,
          resolve: (response) => {
            settle();
            resolve(response);
          },
          fail: (err) => {
            settle();
            reject(new Error(`no answer to ${which}: ${err.message}`));
          },
        });
        // Reported rather than ignored: a false here means the write was
        // dropped, which used to be indistinguishable from an app that never
        // answered.
        const line = JSON.stringify(request) + "\n";
        if (!target.write(line)) {
          // A connection that went away before the write (a socket the peer
          // closed straight after accepting it) took nothing: reconnect once
          // and send it there.
          if (!target.open() && !closedByCaller) {
            void live().then(
              (again) => {
                const w = pending.get(request.id);
                if (!w) return;
                w.conn = again;
                if (!again.write(line)) {
                  settle();
                  reject(new Error(`could not write ${which} to ${options.target} — it is not accepting writes`));
                }
              },
              (err: unknown) => {
                settle();
                reject(new Error(`could not write ${which} to ${options.target}: ${err instanceof Error ? err.message : String(err)}`));
              },
            );
            return;
          }
          settle();
          reject(new Error(`could not write ${which} to ${options.target} — it is not accepting writes`));
        }
      });
    },
    close() {
      closedByCaller = true;
      conn.close();
    },
  };
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
  return createLineRpcClient({
    target: "the container's stdin (the attach stream)",
    connect: async (onLine) => {
      const stream = await attachStream(container, docker, onLine);
      return {
        write: (line) => stream.write(line),
        open: () => !(stream.destroyed || stream.readableEnded),
        close: () => stream.end(),
      };
    },
  });
}

/**
 * One attach connection, its stdout split into lines for the client, so a
 * replacement stream resolves calls the same way the original did.
 */
async function attachStream(container: Docker.Container, docker: Docker, onLine: (line: string) => void): Promise<Duplex> {
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
    for (const line of lines) onLine(line);
  });

  // Without this, an error on the socket is an unhandled "error" event, which
  // Node turns into an uncaught exception in whatever process is driving the
  // container.
  stream.on("error", () => {});

  return stream;
}
