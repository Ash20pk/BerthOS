import { Duplex } from "node:stream";
import net from "node:net";

/**
 * A socket-shaped stream that reaches host:port through the sandbox's egress
 * proxy with an HTTP CONNECT tunnel, for mysql2's `stream` option (the same
 * tunnel apps/postgres gives node-postgres).
 *
 * The tunnel's own handshake happens underneath: this connects to the proxy,
 * sends CONNECT, and only once the proxy answers 200 does it emit "connect"
 * and pass bytes through. Writes made before then are queued. The proxy
 * checks the host and port against berth.yml and never decrypts anything:
 * mysql2 negotiates TLS over this stream itself.
 */
export class ProxyTunnel extends Duplex {
  private inner: net.Socket | undefined;
  private queued: { chunk: Buffer; encoding: BufferEncoding; callback: (err?: Error | null) => void }[] = [];

  constructor(private readonly proxy: URL) {
    super();
  }

  connect(port: number, host: string): this {
    const socket = net.connect(Number(this.proxy.port) || 80, this.proxy.hostname);
    let header = Buffer.alloc(0);
    const onHandshake = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onHandshake);
      const status = header.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "";
      if (!/^HTTP\/1\.[01] 200\b/.test(status)) {
        socket.destroy();
        this.destroy(new Error(`the sandbox's egress proxy refused ${host}:${port} (${status}): it isn't a network:host: entry in berth.yml, or it's an internal address`));
        return;
      }
      this.inner = socket;
      if (!this.refed) socket.unref();
      socket.on("data", (data: Buffer) => {
        if (!this.push(data)) socket.pause();
      });
      socket.on("end", () => this.push(null));
      socket.on("close", () => this.destroy());
      for (const w of this.queued.splice(0)) socket.write(w.chunk, w.encoding, w.callback);
      this.emit("connect");
      const rest = header.subarray(end + 4);
      if (rest.length > 0) this.push(rest);
    };
    socket.on("data", onHandshake);
    socket.on("error", (err) => this.destroy(err));
    socket.once("connect", () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    return this;
  }

  override _read(): void {
    this.inner?.resume();
  }

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
    if (!this.inner) {
      this.queued.push({ chunk, encoding, callback });
      return;
    }
    this.inner.write(chunk, encoding, callback);
  }

  override _final(callback: (err?: Error | null) => void): void {
    this.inner?.end();
    callback();
  }

  override _destroy(err: Error | null, callback: (err?: Error | null) => void): void {
    this.inner?.destroy();
    callback(err);
  }

  // Socket methods a driver may call beyond what a Duplex has (pg-pool calls
  // ref/unref on idle clients; a tunnel without them crashed apps/postgres).
  // Applied to the real socket, and remembered until it exists.
  private refed = true;
  ref(): this {
    this.refed = true;
    this.inner?.ref();
    return this;
  }
  unref(): this {
    this.refed = false;
    this.inner?.unref();
    return this;
  }
  setNoDelay(noDelay?: boolean): this {
    this.inner?.setNoDelay(noDelay);
    return this;
  }
  setKeepAlive(enable?: boolean, initialDelay?: number): this {
    this.inner?.setKeepAlive(enable, initialDelay);
    return this;
  }
}
