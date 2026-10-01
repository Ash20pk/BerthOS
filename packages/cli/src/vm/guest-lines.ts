import type { Socket } from "node:net";

/**
 * Everything read from a guest socket is untrusted guest output
 * (docs/design/microvm-guest-init.md, "The rule for the host side"): every
 * line is bounded, parsed as a JSON object and shape-checked, and nothing in
 * it picks an action on the host beyond the event it is checked to be.
 */
export const MAX_GUEST_LINE = 1 << 20;

/** Splits a stream into lines, each handed to `onObject` only if it is a JSON object. A line over `maxLine` ends the stream. */
export function readJsonLines(socket: Socket, onObject: (value: Record<string, unknown>) => void, maxLine = MAX_GUEST_LINE): void {
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const value = parseObject(line);
      if (value) onObject(value);
    }
    if (buf.length > maxLine) socket.destroy(new Error(`a guest line exceeded ${maxLine} bytes`));
  });
}

export function parseObject(line: string): Record<string, unknown> | undefined {
  if (line.length > MAX_GUEST_LINE) return undefined;
  try {
    const v = JSON.parse(line) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** One berth-init control event, shape-checked. */
export interface ControlEvent {
  source: "berth-init";
  event: string;
  bootId?: string;
  uptimeMs?: number;
  [key: string]: unknown;
}

export function asControlEvent(v: Record<string, unknown>): ControlEvent | undefined {
  if (v.source !== "berth-init" || typeof v.event !== "string") return undefined;
  if (v.bootId !== undefined && typeof v.bootId !== "string") return undefined;
  return v as ControlEvent;
}

/** One log-port line: {"t","src","stream","line"}. */
export interface GuestLogLine {
  t: number;
  src: string;
  stream: string;
  line: string;
}

export function asGuestLogLine(v: Record<string, unknown>): GuestLogLine | undefined {
  if (typeof v.src !== "string" || typeof v.stream !== "string" || typeof v.line !== "string") return undefined;
  return { t: typeof v.t === "number" ? v.t : 0, src: v.src.slice(0, 64), stream: v.stream.slice(0, 16), line: v.line };
}

/** A guest string for a terminal: control characters (escape sequences included) removed. */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
