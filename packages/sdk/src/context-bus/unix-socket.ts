import * as net from "node:net";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import type { ContextBusClient } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Package asset — see this package's "files" field — kept in sync by hand
// with packages/context-bus-daemon/proto/context_bus.proto. Resolved against
// two candidate layouts so the same source works both under tsc's nested
// dist/context-bus/unix-socket.js (climb two levels to package root) and
// under the flat, single-file dist-external/ bundle built for external
// consumers (climb zero — proto/ sits right next to the bundle).
function resolveProtoPath(): string {
  const nested = path.join(__dirname, "..", "..", "proto", "context_bus.proto");
  if (existsSync(nested)) return nested;
  const flat = path.join(__dirname, "proto", "context_bus.proto");
  if (existsSync(flat)) return flat;
  throw new Error(`context_bus.proto not found at ${nested} or ${flat}`);
}

const CONNECT_TIMEOUT_MS = 2000;

/**
 * Real context-bus client, talking to Phase 2's Rust daemon over a Unix
 * socket with length-prefixed protobuf Envelope frames. Implements the same
 * ContextBusClient interface as Phase 1's local no-op — resident app code
 * doesn't change based on which implementation runtime.ts wires in.
 */
export async function createUnixSocketContextBus(socketPath: string): Promise<ContextBusClient> {
  const root = await protobuf.load(resolveProtoPath());
  const Envelope = root.lookupType("berth.contextbus.Envelope");

  const socket = await connect(socketPath);

  const subscriptions = new Map<string, Set<(payload: unknown) => void>>();
  let readBuffer = Buffer.alloc(0);

  socket.on("data", (chunk: Buffer) => {
    readBuffer = Buffer.concat([readBuffer, chunk]);
    while (readBuffer.length >= 4) {
      const len = readBuffer.readUInt32BE(0);
      if (readBuffer.length < 4 + len) break;
      const frame = readBuffer.subarray(4, 4 + len);
      readBuffer = readBuffer.subarray(4 + len);
      handleFrame(frame);
    }
  });

  function handleFrame(frame: Buffer): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = Envelope.decode(frame) as any;
    if (message.event) {
      const { topic, payload } = message.event as { topic: string; payload: Uint8Array };
      const handlers = subscriptions.get(topic);
      if (!handlers) return;
      const decoded = payload && payload.length ? JSON.parse(Buffer.from(payload).toString("utf-8")) : undefined;
      for (const handler of handlers) handler(decoded);
    }
    // register/publish/subscribe acks aren't correlated to a specific call
    // in Phase 2 — fire-and-forget is enough for "does the message arrive."
  }

  function send(kind: "register" | "publish" | "subscribe" | "unsubscribe", payload: object): void {
    const message = Envelope.create({ [kind]: payload });
    const encoded = Envelope.encode(message).finish();
    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32BE(encoded.length, 0);
    socket.write(Buffer.concat([lengthPrefix, Buffer.from(encoded)]));
  }

  return {
    async register(info) {
      send("register", { app: info.app });
    },
    async publish(topic, payload) {
      const bytes = Buffer.from(JSON.stringify(payload ?? null), "utf-8");
      send("publish", { topic, payload: bytes });
    },
    subscribe(topic, handler) {
      if (!subscriptions.has(topic)) {
        subscriptions.set(topic, new Set());
        send("subscribe", { topic });
      }
      subscriptions.get(topic)!.add(handler);

      return () => {
        const handlers = subscriptions.get(topic);
        handlers?.delete(handler);
        if (handlers && handlers.size === 0) {
          subscriptions.delete(topic);
          send("unsubscribe", { topic });
        }
      };
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
