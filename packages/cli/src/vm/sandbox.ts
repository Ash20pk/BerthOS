import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { createLineRpcClient, type StdioRpcClient } from "@berthos/docker-orchestrator";
import { BootFailedError, connectUnix, openControl, requestStatus, waitForReady, type ControlConnection, type ReadyResult } from "./control.js";
import { asGuestLogLine, parseObject, readJsonLines, type ControlEvent, type GuestLogLine } from "./guest-lines.js";
import { MAX_SOCKET_PATH, vmRunDir, vmRunRoot } from "./paths.js";

/**
 * One local microVM sandbox: `berth-vmm run` as a detached host process, and
 * the host side of berth-init's port plan.
 *
 *   start   spawns `berth-vmm run` detached (it outlives a CLI that dies;
 *           `find` gets it back), run dir ~/.berth/run/vm/<name>/ (0700),
 *           its stderr in vmm.log, its pid in berth-vmm.pid, and vm.json
 *   ready   waits for every app's app_ready on control.sock
 *   call    line RPC over rpc-<i>.sock (docker-orchestrator's line client)
 *   logs    logs.sock, one reader at a time (berth-init's rule), so the
 *           process that started the VM pumps it into guest.log and to its
 *           subscribers, and everyone else reads the file
 *   stop    {"op":"shutdown"} on control, SIGKILL after a timeout; the
 *           sockets, pid file and vm.json are removed
 *   find    a running VM by its run dir: pid alive, the process is this
 *           run dir's berth-vmm, control greets; anything less is stale and
 *           cleaned up
 */

export const VM_RECORD = "vm.json";
export const PID_FILE = "berth-vmm.pid";
export const VMM_LOG = "vmm.log";
export const GUEST_LOG = "guest.log";
/** guest.log stops growing past this; the console.log written by berth-vmm still has everything. */
export const GUEST_LOG_MAX_BYTES = 32 << 20;

export interface VmmLines {
  endpoints?: Record<string, unknown>;
  vmConfig?: Record<string, unknown>;
  measurements?: Record<string, unknown>;
}

export interface VmRecord {
  schema: 1;
  name: string;
  pid: number;
  /** The process that started it and pumps its logs. */
  owner: number;
  vmm: string;
  runDir: string;
  startedAt: string;
  apps: { index: number; name: string; share: string; appDir?: string }[];
  state?: string;
  endpoints?: Record<string, unknown>;
  vmConfig?: Record<string, unknown>;
  measurements?: Record<string, unknown>;
}

export interface StartOptions {
  name: string;
  vmm: string;
  /** Bundled app share directories, primary app first. */
  apps: { name: string; share: string; appDir?: string }[];
  /** State disk for /workspace; omitted, /workspace is tmpfs. */
  state?: string;
  stateSizeMiB?: number;
  cpus?: number;
  memMiB?: number;
  /** Default ~/.berth/vm (berth-vmm's own default). */
  artifactsDir?: string;
  env?: string[];
  readyTimeoutMs?: number;
  /** Lines from the guest's log port, as they arrive. */
  onLog?: (line: GuestLogLine) => void;
  signal?: AbortSignal;
  /** Injectable for tests. */
  spawn?: typeof nodeSpawn;
  /** Override the run dir (tests). */
  runDir?: string;
}

export interface StartTimings {
  spawnMs: number;
  /** Until berth-vmm printed its measurement line (it hashed kernel, rootfs, state). */
  measuredMs?: number;
  controlMs?: number;
  readyMs: number;
}

export function readVmmLines(text: string): VmmLines {
  const out: VmmLines = {};
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    const v = parseObject(line);
    if (!v || v.source !== "berth-vmm") continue;
    if (v.event === "endpoints") out.endpoints = v;
    else if (v.event === "vm_config") out.vmConfig = v;
    else if (v.event === "measurements") out.measurements = v;
  }
  return out;
}

function tail(text: string, lines = 12): string {
  return text
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("{\"source\":\"berth-vmm\""))
    .slice(-lines)
    .join("\n");
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether `pid` is a berth-vmm serving this run dir (guards against a reused pid). */
export function isVmmFor(pid: number, runDir: string, run = spawnSync): boolean {
  const r = run("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  const cmd = (r.stdout ?? "").trim();
  return cmd.includes("berth-vmm") && cmd.includes(runDir);
}

export function cleanRunDir(runDir: string): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(runDir);
  } catch {
    return;
  }
  for (const f of entries) {
    if (f.endsWith(".sock") || f === PID_FILE || f === VM_RECORD) rmSync(join(runDir, f), { force: true });
  }
}

export class VmSandbox {
  private control?: ControlConnection;
  private rpcClients = new Map<number, StdioRpcClient>();
  private logSubscribers = new Set<(line: GuestLogLine) => void>();
  private pumping = false;
  private exited: Promise<void>;
  private child?: ChildProcess;

  private constructor(
    readonly record: VmRecord,
    child?: ChildProcess,
  ) {
    this.child = child;
    this.exited = child
      ? new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("exit", () => resolve());
        })
      : this.pollExit();
  }

  get name(): string {
    return this.record.name;
  }
  get runDir(): string {
    return this.record.runDir;
  }
  get pid(): number {
    return this.record.pid;
  }
  get bootId(): string | undefined {
    return this.control?.bootId;
  }
  controlEvents(): ControlEvent[] {
    return this.control?.events ?? [];
  }

  private pollExit(): Promise<void> {
    return new Promise((resolve) => {
      const t = setInterval(() => {
        if (!pidAlive(this.record.pid)) {
          clearInterval(t);
          resolve();
        }
      }, 100);
      t.unref();
    });
  }

  /** Resolves when the berth-vmm process has exited. */
  whenExited(): Promise<void> {
    return this.exited;
  }

  isRunning(): boolean {
    return pidAlive(this.record.pid);
  }

  static async start(options: StartOptions): Promise<{ sandbox: VmSandbox; ready: ReadyResult; timings: StartTimings }> {
    const t0 = Date.now();
    const runDir = options.runDir ?? vmRunDir(options.name);
    const longest = join(runDir, `rpc-${Math.max(0, options.apps.length - 1)}.sock`);
    if (longest.length > MAX_SOCKET_PATH) {
      throw new Error(`the run dir ${runDir} is too long for a Unix socket path (${longest.length} > ${MAX_SOCKET_PATH} bytes); set BERTH_HOME to a shorter directory`);
    }
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    chmodSync(runDir, 0o700);
    cleanRunDir(runDir);
    for (const f of [GUEST_LOG, VMM_LOG]) rmSync(join(runDir, f), { force: true });

    const args = ["run", "--run-dir", runDir];
    for (const a of options.apps) args.push("--app", a.share);
    if (options.state) {
      mkdirSync(dirname(options.state), { recursive: true });
      args.push("--state", options.state);
      if (options.stateSizeMiB) args.push("--state-size", String(options.stateSizeMiB));
    }
    if (options.cpus) args.push("--cpus", String(options.cpus));
    if (options.memMiB) args.push("--mem", String(options.memMiB));
    if (options.artifactsDir) args.push("--artifacts", options.artifactsDir);
    for (const e of options.env ?? []) args.push("--env", e);

    // stderr to a file, not a pipe: a detached berth-vmm must not die of
    // SIGPIPE when the CLI that started it goes away.
    const logPath = join(runDir, VMM_LOG);
    const fd = openSync(logPath, "a", 0o600);
    // The host environment is not the guest's (berth-vmm passes an explicit
    // envp), but berth-vmm itself reads BERTH_VMM_ARTIFACTS: pin it to what
    // this call asked for.
    const env = { ...process.env };
    delete env.BERTH_VMM_ARTIFACTS;
    const child = (options.spawn ?? nodeSpawn)(options.vmm, args, { detached: true, stdio: ["ignore", "ignore", fd], env });
    closeSync(fd);
    const spawnError = new Promise<Error>((resolve) => child.once("error", resolve));
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new Error(`could not start ${options.vmm}: ${(await spawnError).message}`);
    writeFileSync(join(runDir, PID_FILE), `${pid}\n`, { mode: 0o600 });

    const record: VmRecord = {
      schema: 1,
      name: options.name,
      pid,
      owner: process.pid,
      vmm: options.vmm,
      runDir,
      startedAt: new Date().toISOString(),
      apps: options.apps.map((a, index) => ({ index, name: a.name, share: a.share, ...(a.appDir ? { appDir: a.appDir } : {}) })),
      ...(options.state ? { state: options.state } : {}),
    };
    const sandbox = new VmSandbox(record, child);
    if (options.onLog) sandbox.logSubscribers.add(options.onLog);
    const timings: StartTimings = { spawnMs: Date.now() - t0, readyMs: 0 };
    const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
    try {
      // berth-vmm prints endpoints, vm_config and measurements, then boots.
      // A refusal (bad pin, missing artifact, unsigned binary) exits here.
      const lines = await sandbox.waitForVmmLines(logPath, readyTimeoutMs, options.signal);
      Object.assign(record, lines);
      timings.measuredMs = Date.now() - t0;
      sandbox.writeRecord();
      sandbox.startLogPump();
      const control = await Promise.race([
        openControl(join(runDir, "control.sock"), { timeoutMs: readyTimeoutMs, ...(options.signal ? { signal: options.signal } : {}) }),
        sandbox.exited.then(() => {
          throw new BootFailedError(`berth-vmm exited during boot:\n${tail(readText(logPath))}`);
        }),
      ]);
      sandbox.control = control;
      timings.controlMs = Date.now() - t0;
      const ready = await waitForReady(control, options.apps.length, readyTimeoutMs, options.signal);
      timings.readyMs = Date.now() - t0;
      return { sandbox, ready, timings };
    } catch (err) {
      await sandbox.stop({ timeoutMs: 2_000 }).catch(() => {});
      throw err;
    }
  }

  private async waitForVmmLines(logPath: string, timeoutMs: number, signal?: AbortSignal): Promise<VmmLines> {
    const deadline = Date.now() + timeoutMs;
    let exited = false;
    void this.exited.then(() => (exited = true));
    for (;;) {
      const text = readText(logPath);
      const lines = readVmmLines(text);
      if (lines.endpoints && lines.measurements) return lines;
      if (exited) {
        throw new BootFailedError(`berth-vmm exited before it booted the VM${this.child?.exitCode != null ? ` (exit ${this.child.exitCode})` : ""}:\n${tail(text) || "(no output)"}`);
      }
      if (signal?.aborted) throw new Error("cancelled while berth-vmm was starting");
      if (Date.now() > deadline) throw new Error(`berth-vmm printed no measurement line within ${Math.round(timeoutMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private writeRecord(): void {
    const path = join(this.runDir, VM_RECORD);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(this.record, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  /**
   * Finds the sandbox `name`: a live VM, or undefined. A run dir whose VM is
   * gone (pid dead, or the pid now belongs to something else) is cleaned up
   * and reported as stale through `onStale`.
   */
  static async find(name: string, options: { runDir?: string; onStale?: (why: string) => void; controlTimeoutMs?: number } = {}): Promise<VmSandbox | undefined> {
    const runDir = options.runDir ?? vmRunDir(name);
    const recordPath = join(runDir, VM_RECORD);
    const pidPath = join(runDir, PID_FILE);
    if (!existsSync(pidPath) && !existsSync(recordPath)) return undefined;
    let record: VmRecord | undefined;
    try {
      record = JSON.parse(readFileSync(recordPath, "utf8")) as VmRecord;
    } catch {}
    const pid = record?.pid ?? Number(readText(pidPath).trim());
    const stale = (why: string) => {
      options.onStale?.(why);
      cleanRunDir(runDir);
      return undefined;
    };
    if (!Number.isInteger(pid) || pid <= 0) return stale("no pid recorded");
    if (!pidAlive(pid)) return stale(`berth-vmm (pid ${pid}) is no longer running`);
    if (!isVmmFor(pid, runDir)) return stale(`pid ${pid} is no longer this sandbox's berth-vmm`);
    if (!record) return stale(`no ${VM_RECORD} for pid ${pid}`);
    const sandbox = new VmSandbox(record);
    try {
      sandbox.control = await openControl(join(runDir, "control.sock"), { timeoutMs: options.controlTimeoutMs ?? 3_000 });
    } catch (err) {
      // Alive but not answering: still booting, or wedged. Not stale; the caller decides.
      throw new Error(`the sandbox "${name}" (berth-vmm pid ${pid}) is running but its control port didn't answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    return sandbox;
  }

  /** Every sandbox with a run dir, live or not (status listing). */
  static listNames(): string[] {
    try {
      return readdirSync(vmRunRoot(), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  async waitReady(timeoutMs: number, signal?: AbortSignal): Promise<ReadyResult> {
    if (!this.control) throw new Error("not connected");
    return waitForReady(this.control, this.record.apps.length, timeoutMs, signal);
  }

  async status(): Promise<ControlEvent> {
    if (!this.control) throw new Error("not connected");
    return requestStatus(this.control);
  }

  appIndex(app: string): number | undefined {
    if (/^\d+$/.test(app)) return Number(app) < this.record.apps.length ? Number(app) : undefined;
    return this.record.apps.find((a) => a.name === app)?.index;
  }

  /** The app's RPC over rpc-<i>.sock, one connection reused across calls and reopened if it closes. */
  async rpc(index = 0): Promise<StdioRpcClient> {
    const existing = this.rpcClients.get(index);
    if (existing) return existing;
    const path = join(this.runDir, `rpc-${index}.sock`);
    const client = await createLineRpcClient({
      target: `the VM's ${path}`,
      failPendingOnClose: true,
      connect: async (onLine, onClose) => {
        const socket = await connectUnix(path, Date.now() + 5_000);
        let open = true;
        let buf = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            onLine(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
          // An answer can be large (a file's contents); a line with no end in sight is not one.
          if (buf.length > 64 << 20) socket.destroy(new Error("an RPC line from the guest exceeded 64 MiB"));
        });
        socket.on("error", () => {});
        socket.once("close", () => {
          open = false;
          onClose();
        });
        // A socket queues what it can't send yet, so false from write() is
        // backpressure, not a drop; only a socket that can no longer be
        // written to (the guest closed it) refuses a request.
        const writable = () => open && !socket.destroyed && socket.writable;
        return {
          write: (line) => {
            if (!writable()) return false;
            socket.write(line);
            return true;
          },
          open: writable,
          close: () => socket.end(),
        };
      },
    });
    this.rpcClients.set(index, client);
    return client;
  }

  /** Subscribes to guest log lines. In the process that started the VM they come from the log port; elsewhere, use readGuestLog. */
  onLog(fn: (line: GuestLogLine) => void): () => void {
    this.logSubscribers.add(fn);
    return () => this.logSubscribers.delete(fn);
  }

  /** Pumps logs.sock into guest.log and the subscribers until the VM exits. */
  startLogPump(): void {
    if (this.pumping) return;
    this.pumping = true;
    const path = join(this.runDir, "logs.sock");
    const file = join(this.runDir, GUEST_LOG);
    let written = 0;
    // berth-init replays its ring on every connection: skip what was seen.
    let lastT = -1;
    let seenAtLastT = new Set<string>();
    const connect = async () => {
      while (this.isRunning()) {
        let socket: net.Socket;
        try {
          socket = await connectUnix(path, Date.now() + 2_000);
        } catch {
          continue;
        }
        await new Promise<void>((resolve) => {
          socket.on("error", () => {});
          socket.once("close", () => resolve());
          readJsonLines(socket, (v) => {
            const line = asGuestLogLine(v);
            if (!line) return;
            const key = `${line.src}\0${line.stream}\0${line.line}`;
            if (line.t < lastT || (line.t === lastT && seenAtLastT.has(key))) return;
            if (line.t > lastT) {
              lastT = line.t;
              seenAtLastT = new Set();
            }
            seenAtLastT.add(key);
            const text = `${JSON.stringify(line)}\n`;
            if (written < GUEST_LOG_MAX_BYTES) {
              written += text.length;
              try {
                appendFileSync(file, text, { mode: 0o600 });
              } catch {}
            }
            for (const fn of this.logSubscribers) fn(line);
          });
        });
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    void connect();
  }

  /**
   * Stops the VM: {"op":"shutdown"} (apps stopped, disks synced and
   * unmounted, power off), SIGKILL if berth-vmm is still there after
   * `timeoutMs`. The run dir's sockets, pid file and record are removed.
   */
  async stop(options: { timeoutMs?: number } = {}): Promise<{ clean: boolean; killed: boolean; powerOff?: ControlEvent }> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    for (const c of this.rpcClients.values()) c.close();
    this.rpcClients.clear();
    let powerOff: ControlEvent | undefined;
    let killed = false;
    if (this.isRunning()) {
      let control = this.control;
      if (!control) control = await openControl(join(this.runDir, "control.sock"), { timeoutMs: Math.min(2_000, timeoutMs) }).catch(() => undefined);
      if (control) {
        const off = control.onEvent((e) => {
          if (e.event === "power_off") powerOff = e;
        });
        control.send("shutdown");
        await Promise.race([this.exited, new Promise((r) => setTimeout(r, timeoutMs))]);
        off();
        powerOff ??= control.events.find((e) => e.event === "power_off");
        control.close();
      }
      if (this.isRunning()) {
        killed = true;
        try {
          process.kill(this.record.pid, "SIGKILL");
        } catch {}
        await Promise.race([this.exited, new Promise((r) => setTimeout(r, 2_000))]);
      }
    }
    this.control = undefined;
    cleanRunDir(this.runDir);
    return { clean: !killed && powerOff !== undefined, killed, ...(powerOff ? { powerOff } : {}) };
  }

  /** Closes this process's connections without stopping the VM (a reattached caller leaving). */
  detach(): void {
    for (const c of this.rpcClients.values()) c.close();
    this.rpcClients.clear();
    this.control?.close();
    this.control = undefined;
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The guest log lines the owning process saved (guest.log), for a reader that isn't the owner. */
export function readGuestLog(runDir: string): GuestLogLine[] {
  const out: GuestLogLine[] = [];
  for (const line of readText(join(runDir, GUEST_LOG)).split("\n")) {
    const v = parseObject(line);
    const l = v && asGuestLogLine(v);
    if (l) out.push(l);
  }
  return out;
}

