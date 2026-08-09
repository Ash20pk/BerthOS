import * as net from "node:net";
import type { SemanticFsClient, SemanticFsQueryResult } from "./client.js";
import { EMBEDDING_MODEL, embedText, warmup } from "./embeddings.js";

const CONNECT_TIMEOUT_MS = 2000;
const CALL_TIMEOUT_MS = 5000;

interface RawResult {
  path: string;
  created_by?: string;
  task?: string;
  related_apps?: string[];
  created_at: number;
  updated_at: number;
}

interface RawResponse {
  id: string;
  ok: boolean;
  error?: string;
  results?: RawResult[];
}

/**
 * Real semantic-fs client, talking to Phase 4's Go daemon over a Unix
 * socket with length-prefixed JSON frames — the same 4-byte-BE-length
 * framing as the context bus's protobuf Envelopes, but JSON, since these are
 * low-frequency call/response control operations rather than a
 * high-throughput event stream (see semantic-fs-daemon/internal/control for
 * the server side of this protocol).
 */
export async function createUnixSocketSemanticFs(socketPath: string): Promise<SemanticFsClient> {
  const socket = await connect(socketPath);

  let nextId = 1;
  const pending = new Map<string, { resolve: (resp: RawResponse) => void; reject: (err: Error) => void }>();
  let readBuffer = Buffer.alloc(0);

  socket.on("data", (chunk: Buffer) => {
    readBuffer = Buffer.concat([readBuffer, chunk]);
    while (readBuffer.length >= 4) {
      const length = readBuffer.readUInt32BE(0);
      if (readBuffer.length < 4 + length) break;
      const frame = readBuffer.subarray(4, 4 + length);
      readBuffer = readBuffer.subarray(4 + length);
      handleFrame(frame);
    }
  });

  // Whether the connection has gone away, and why. Without this, a daemon that
  // dies mid-life fails in two bad ways: every subsequent call sits until
  // CALL_TIMEOUT_MS before rejecting with a timeout that names nothing useful,
  // and — worse — `socket.write()` on a destroyed socket emits an "error"
  // event that nothing was listening for, which in Node is an uncaught
  // exception that takes the whole app down. Both are the same failure this
  // client is meant to report clearly (REMEDIATION.md 1.14).
  let closedReason: string | undefined;

  function fail(reason: string): void {
    closedReason ??= reason;
    for (const waiter of pending.values()) waiter.reject(new Error(`semantic-fs control socket ${reason}`));
    pending.clear();
  }

  socket.on("close", () => fail("closed"));
  socket.on("error", (err) => fail(`failed: ${err.message}`));

  function handleFrame(frame: Buffer): void {
    const resp = JSON.parse(frame.toString("utf-8")) as RawResponse;
    const waiter = pending.get(resp.id);
    if (!waiter) return;
    pending.delete(resp.id);
    waiter.resolve(resp);
  }

  function call(op: string, fields: Record<string, unknown>): Promise<RawResponse> {
    if (closedReason) {
      // Rejected immediately and by name, rather than after a 5s timeout that
      // would read as "the daemon is slow" instead of "the daemon is gone".
      return Promise.reject(new Error(`semantic-fs call "${op}" cannot be sent: the control socket ${closedReason}`));
    }
    const id = String(nextId++);
    const encoded = Buffer.from(JSON.stringify({ id, op, ...fields }), "utf-8");
    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32BE(encoded.length, 0);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`semantic-fs call "${op}" timed out after ${CALL_TIMEOUT_MS}ms`));
      }, CALL_TIMEOUT_MS);
      pending.set(id, {
        resolve: (resp) => {
          clearTimeout(timer);
          resolve(resp);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      socket.write(Buffer.concat([lengthPrefix, encoded]));
    });
  }

  // Kicks off the embedding model's WASM/weights load in the background as
  // soon as this client exists, in parallel with the app's own onAgentReady
  // setup — so it's likely already warm by the time real tag()/query() calls
  // happen, rather than paying the full cold-start latency inline on the
  // first one.
  warmup();

  return {
    async register(info) {
      const resp = await call("register", { pid: process.pid, app: info.app });
      if (!resp.ok) throw new Error(resp.error ?? "register failed");
    },
    async tag(path, meta) {
      const task = meta.task ?? "";
      const relatedApps = meta.relatedApps ?? [];
      const embedding = await embedText(`${task} ${relatedApps.join(" ")} ${path}`.trim());
      const resp = await call("tag", {
        path,
        task,
        related_apps: relatedApps,
        ...(embedding ? { embedding, model: EMBEDDING_MODEL } : {}),
      });
      if (!resp.ok) throw new Error(resp.error ?? "tag failed");
    },
    async query(text, limit): Promise<SemanticFsQueryResult[]> {
      const embedding = await embedText(text);
      const resp = await call("query", {
        text,
        limit: limit ?? 0,
        ...(embedding ? { embedding, model: EMBEDDING_MODEL } : {}),
      });
      if (!resp.ok) throw new Error(resp.error ?? "query failed");
      return (resp.results ?? []).map((r) => ({
        path: r.path,
        createdBy: r.created_by || undefined,
        task: r.task || undefined,
        relatedApps: r.related_apps,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    },
  };
}

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to ${socketPath} after ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
