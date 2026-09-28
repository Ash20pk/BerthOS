import { Duplex } from "node:stream";
import net from "node:net";

/**
 * A socket-shaped stream that reaches host:port through the sandbox's egress
 * proxy with an HTTP CONNECT tunnel, for node-postgres's `stream` option.
 *
 * pg calls `connect(port, host)` on whatever stream it's given and listens
 * for "connect" and "data" straight away, so the tunnel's own handshake has to
 * happen underneath: this connects to the proxy, sends CONNECT, and only once
 * the proxy answers 200 does it emit "connect" and start passing bytes
 * through. The proxy checks the host and port against berth.yml and never
 * decrypts anything: pg negotiates TLS over this stream itself.
 */
export class ProxyTunnel extends Duplex {
  private inner: net.Socket | undefined;

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
    if (!this.inner) return callback(new Error("the tunnel isn't open yet"));
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

  // The socket methods pg and pg-pool call on their stream beyond what a
  // Duplex has. ref/unref decide whether an idle connection keeps the process
  // alive; pg-pool calls them on every idle client, so a tunnel without them
  // crashed the app on its second query. Applied to the real socket, and
  // remembered until it exists.
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
