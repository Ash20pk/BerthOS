import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

const SESSION_NAME = "berth-terminal";
const TTYD_PORT = process.env.BERTH_TERMINAL_PORT ?? "7681";

function workspaceRoot(): string {
  return process.env.BERTH_WORKSPACE_ROOT ?? "/workspace";
}

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args);
  return stdout;
}

let sessionReady: Promise<void> | undefined;

/**
 * `user:password` for ttyd's HTTP basic auth. Normally generated per boot by
 * the host (container.ts) and passed in, so `berth dev` can print it next to
 * the URL — the container has no way to show a human anything except a log
 * line every resident app in it can also read.
 *
 * The fallback is deliberately *not* "start without a credential": running
 * `apps/terminal` some other way (a bare `docker run`, a test harness) would
 * then quietly produce an unauthenticated writable root shell, which is the
 * exact failure this closes. It generates one and logs it instead, which is
 * worse than being handed one but strictly better than none.
 */
function credential(): string {
  const provided = process.env.BERTH_TERMINAL_CREDENTIAL;
  if (provided) return provided;
  const generated = `berth:${randomUUID()}`;
  console.warn(`[terminal] no BERTH_TERMINAL_CREDENTIAL was passed in; generated one for this boot: ${generated}`);
  return generated;
}

/**
 * Lazily creates the shared tmux session (first call only) and starts ttyd
 * attached to it, both spawned as children of this already-Landlocked
 * process (see berth.yml) rather than by entrypoint.sh — unlike Xvfb for
 * browser:*, a pty needs no pre-existing display server, so there's no
 * ordering dependency forcing this earlier. That also means the shell
 * inherits whatever filesystem/network capabilities this app declared,
 * exactly like Chromium inherits apps/browser-native's.
 *
 * ttyd is started once and left running for the container's lifetime — any
 * number of browser tabs can attach to it concurrently, and (being plain
 * `tmux attach`) they all see the exact same session run_command/send_keys
 * drive, not a fresh shell per connection.
 */
export function ensureSession(): Promise<void> {
  if (!sessionReady) {
    sessionReady = (async () => {
      const hasSession = await tmux("has-session", "-t", SESSION_NAME)
        .then(() => true)
        .catch(() => false);
      if (!hasSession) {
        // -x/-y: wide and tall, not tmux's narrow ~80x24 default — run_command's
        // marker-search (below) needs the command + sentinel it sends to
        // survive as one unbroken line. A real terminal's own line-editor
        // (readline/zle) wraps long input across the pty's column width as
        // it's typed, same as any interactive shell would, and that wrap
        // isn't something tmux capture-pane's -J (join-wrapped-lines) flag
        // undoes — confirmed against a real tmux session, where even -J left
        // a long sentinel split mid-line. Widening the pane itself (rather
        // than shrinking the sentinel further) keeps room for genuinely long
        // agent-issued commands too.
        await execFileAsync("tmux", ["new-session", "-d", "-x", "500", "-y", "50", "-s", SESSION_NAME, "-c", workspaceRoot()]);
      }
      // No -i/--interface: ttyd's default (iface = NULL) binds all
      // interfaces, which is what Docker's port mapping needs to reach it
      // from the host — -i takes an interface *name* (e.g. "eth0") or a
      // Unix socket path, not an IP address, so there's no "0.0.0.0" form
      // of it to pass explicitly. Which is exactly why --credential is not
      // optional here: this is a *writable* shell running as root, and the
      // only reason it isn't reachable from the LAN is that container.ts
      // binds the published port to loopback. Defence in depth, because
      // that binding is one `--publish-host` away from being widened.
      const ttyd = spawn("ttyd", ["--credential", credential(), "--writable", "-p", TTYD_PORT, "tmux", "attach", "-t", SESSION_NAME], {
        stdio: "ignore",
      });
      // Without this, a failed spawn (e.g. ttyd missing) fires an unhandled
      // 'error' event on the ChildProcess, which Node treats as an uncaught
      // exception and takes the whole resident app process down with it —
      // the human-facing web view is best-effort, not something that should
      // be able to crash run_command/read_screen/send_keys.
      ttyd.on("error", (err) => {
        console.error(`[terminal] ttyd failed to start (the shared shell itself is unaffected): ${err}`);
      });
      ttyd.unref();
    })();
  }
  return sessionReady;
}

async function capturePane(fullHistory: boolean): Promise<string> {
  const args = ["capture-pane", "-t", SESSION_NAME, "-p"];
  if (fullHistory) args.push("-S", "-");
  return tmux(...args);
}

/** Current visible screen content — what a human looking at the ttyd view would see right now. */
export async function readScreen(): Promise<string> {
  await ensureSession();
  return capturePane(false);
}

/**
 * Raw pass-through to `tmux send-keys` — `keys` is a whitespace-separated
 * sequence of tmux key names (e.g. "C-c", "Up", "Enter"), not literal text.
 * For running an actual command line, use `run_command` instead.
 */
export async function sendKeys(keys: string): Promise<void> {
  await ensureSession();
  const tokens = keys.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return;
  await execFileAsync("tmux", ["send-keys", "-t", SESSION_NAME, ...tokens]);
}

/**
 * Sends `command`, then polls the pane's scrollback for a one-off sentinel
 * echoed right after it, and returns just the text produced in between —
 * the same technique `expect` scripts use to drive an interactive shell.
 *
 * Deliberately searches for the *last* occurrence of the literal
 * `command; echo <sentinel>` text we sent, rather than counting lines from
 * a "before" snapshot: a shell can redraw/re-echo its prompt line one or
 * more times right after a pty is first attached to (confirmed against a
 * real tmux session — harmless, but it makes any line-count-based offset
 * unreliable). Searching for the marker itself is immune to how many times
 * it got redrawn, since only the *last* redraw is followed by real output.
 *
 * Known limitation (demo-grade, not a byte-exact pty parser): a command
 * that runs longer than `timeoutMs`, or is verbose enough to overflow
 * tmux's own scrollback (history-limit) before the sentinel appears, can
 * return partial or empty output.
 */
export async function runCommand(command: string, timeoutMs = 15000): Promise<string> {
  await ensureSession();
  // Short on purpose (not a full UUID) — keeps `marker` below as close to
  // just `command`'s own length as possible, since the 500-column pane
  // above is generous but a sufficiently long agent-issued command could
  // still approach it.
  const sentinel = `bd${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const marker = `${command}; echo ${sentinel}`;
  await execFileAsync("tmux", ["send-keys", "-t", SESSION_NAME, marker, "Enter"]);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const captured = await capturePane(true);
    const markerIndex = captured.lastIndexOf(marker);
    if (markerIndex !== -1) {
      const afterMarker = captured.slice(markerIndex + marker.length);
      const sentinelIndex = afterMarker.indexOf(sentinel);
      if (sentinelIndex !== -1) {
        return afterMarker.slice(0, sentinelIndex).replace(/^\r?\n/, "").replace(/\s+$/, "");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`command timed out after ${timeoutMs}ms: "${command}"`);
}
