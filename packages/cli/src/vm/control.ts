import net, { type Socket } from "node:net";
import { asControlEvent, readJsonLines, type ControlEvent } from "./guest-lines.js";

/**
 * berth-init's control port (vsock 1024, `control.sock` in the run dir).
 * On connect it sends `hello`, then replays every event of the boot so far,
 * then streams new ones; it takes `{"op":"status"}` and `{"op":"shutdown"}`.
 *
 * libkrun accepts a host connection before the guest is listening, and then
 * closes it (or leaves it silent). So a connection counts only once `hello`
 * has arrived; until then the client reconnects (greeting-or-retry, as
 * packages/vmm/scripts/vm.mjs does).
 */

export const CONNECT_RETRY_MS = 20;
export const GREETING_MS = 2_000;

/** Connects to a Unix socket, retrying while it doesn't exist or refuses, until `deadline`. */
export function connectUnix(path: string, deadline: number, signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (signal?.aborted) return reject(new Error("cancelled"));
      const s = net.createConnection(path);
      const onError = (err: NodeJS.ErrnoException) => {
        s.destroy();
        if (Date.now() > deadline) return reject(new Error(`cannot connect to ${path}: ${err.code ?? err.message}`));
        setTimeout(attempt, CONNECT_RETRY_MS);
      };
      s.once("error", onError);
      s.once("connect", () => {
        s.off("error", onError);
        resolve(s);
      });
    };
    attempt();
  });
}

export interface ControlConnection {
  bootId: string;
  /** Every event received so far, the replayed backlog first. */
  readonly events: ControlEvent[];
  /** Called for each event from now on. Returns an unsubscribe. */
  onEvent(fn: (e: ControlEvent) => void): () => void;
  send(op: "status" | "shutdown"): void;
  /** Resolves when the connection closes (the guest powered off, or close()). */
  readonly closed: Promise<void>;
  close(): void;
}

export async function openControl(path: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<ControlConnection> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const socket = await connectUnix(path, deadline, options.signal);
    const conn = await greet(socket);
    if (conn) return conn;
    if (Date.now() > deadline) throw new Error(`no greeting from berth-init on ${path} within ${Math.round(options.timeoutMs / 1000)}s`);
    if (options.signal?.aborted) throw new Error("cancelled");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The connection, once `hello` arrives; undefined if the socket closed or stayed silent first. */
function greet(socket: Socket): Promise<ControlConnection | undefined> {
  return new Promise((resolve) => {
    const events: ControlEvent[] = [];
    const listeners = new Set<(e: ControlEvent) => void>();
    let bootId: string | undefined;
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((r) => (resolveClosed = r));
    const timer = setTimeout(() => {
      if (bootId === undefined) {
        socket.destroy();
        resolve(undefined);
      }
    }, GREETING_MS);
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(timer);
      resolveClosed();
      if (bootId === undefined) resolve(undefined);
    });
    readJsonLines(socket, (v) => {
      const e = asControlEvent(v);
      if (!e) return;
      if (bootId === undefined) {
        if (e.event !== "hello" || typeof e.bootId !== "string") return;
        bootId = e.bootId;
        clearTimeout(timer);
        resolve({
          bootId,
          events,
          onEvent(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
          send(op) {
            socket.write(`${JSON.stringify({ op })}\n`);
          },
          closed,
          close() {
            socket.destroy();
          },
        });
        return;
      }
      // Events of another boot can't arrive on this connection; drop them if they claim to.
      if (e.bootId !== undefined && e.bootId !== bootId) return;
      events.push(e);
      for (const fn of listeners) fn(e);
    });
  });
}

export class BootFailedError extends Error {}

export interface ReadyResult {
  bootId: string;
  /** Guest uptime (ms) when the last app reported ready. */
  readyUptimeMs?: number;
  apps: string[];
  events: ControlEvent[];
}

/**
 * Resolves once every app has reported `app_ready`; rejects as soon as the
 * boot can't get there (boot_failed, an app refused or exited, power off,
 * the connection closed) or after `timeoutMs`.
 */
export function waitForReady(control: ControlConnection, appCount: number, timeoutMs: number, signal?: AbortSignal): Promise<ReadyResult> {
  return new Promise((resolve, reject) => {
    const ready = new Map<string, number | undefined>();
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve({ bootId: control.bootId, apps: [...ready.keys()], readyUptimeMs: Math.max(...[...ready.values()].map((v) => v ?? 0)), events: control.events });
    };
    const check = (e: ControlEvent) => {
      const app = typeof e.app === "string" ? e.app : "?";
      switch (e.event) {
        case "app_ready":
          ready.set(app, typeof e.uptimeMs === "number" ? e.uptimeMs : undefined);
          if (ready.size >= appCount) finish();
          break;
        case "boot_failed":
          finish(new BootFailedError(`the sandbox failed to boot: ${String(e.reason ?? "no reason given")}`));
          break;
        case "app_refused":
          finish(new BootFailedError(`berth-init refused to start ${app}: ${String(e.reason ?? "no reason given")}`));
          break;
        case "app_exited":
          if (!ready.has(app)) finish(new BootFailedError(`${app} exited before it reported ready (${JSON.stringify(e.exit ?? null)})`));
          break;
        case "power_off":
          finish(new BootFailedError(`the sandbox powered off before every app was ready: ${String(e.reason ?? "")}`));
          break;
      }
    };
    const onAbort = () => finish(new Error("cancelled while waiting for the sandbox to report ready"));
    const timer = setTimeout(() => finish(new Error(`the sandbox's apps did not report ready within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    const unsubscribe = control.onEvent(check);
    for (const e of [...control.events]) check(e);
    void control.closed.then(() => finish(new BootFailedError("the control connection closed before every app was ready (the VM exited)")));
  });
}

/** Sends `status` and returns the answer. */
export function requestStatus(control: ControlConnection, timeoutMs = 5_000): Promise<ControlEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (off(), reject(new Error("no status answer from berth-init"))), timeoutMs);
    const off = control.onEvent((e) => {
      if (e.event !== "status") return;
      clearTimeout(timer);
      off();
      resolve(e);
    });
    control.send("status");
  });
}
