import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

const execFileAsync = promisify(execFile);

const SESSION_NAME = "berth-terminal";
const TTYD_PORT = process.env.BERTH_TERMINAL_PORT ?? "7681";

function workspaceRoot(): string {
  return process.env.BERTH_WORKSPACE_ROOT ?? "/workspace";
}

/**
 * The shell the session runs. tmux takes $SHELL, and without it the user's
 * login shell, and each app runs as its own system user whose login shell is
 * /sbin/nologin. That shell exits the moment tmux starts it, the session
 * closes with it, and the tmux server exits with its last session: every
 * call after the first then failed with "no server running". So $SHELL is
 * used only when it is a real login shell, and /bin/sh otherwise.
 *
 * "Real" means listed in /etc/shells, the system's own list of valid login
 * shells, which leaves out nologin, false, true, sync and anything else that
 * isn't one. A host without /etc/shells falls back to a list of known shells.
 */
const KNOWN_SHELLS = new Set(["sh", "bash", "dash", "ash", "zsh", "ksh", "mksh", "fish", "csh", "tcsh"]);

export function isLoginShell(shell: string, etcShells: string | null = readEtcShells()): boolean {
  if (!shell.startsWith("/") || !existsSync(shell)) return false;
  if (etcShells !== null) {
    return etcShells.split("\n").some((line) => line.trim() === shell);
  }
  return KNOWN_SHELLS.has(basename(shell));
}

function readEtcShells(): string | null {
  try {
    return readFileSync("/etc/shells", "utf8");
  } catch {
    return null;
  }
}

function sessionShell(): string {
  const shell = process.env.SHELL;
  return shell && isLoginShell(shell) ? shell : "/bin/sh";
}

/**
 * The environment tmux, the shell and ttyd get: what a terminal needs to
 * work, and nothing else. Not this process's own environment, which carries
 * the app's secrets (BERTH_TERMINAL_CREDENTIAL, BERTH_HTTP_RPC_TOKEN, the
 * values of any declared secrets, provider API keys): the tmux server copies
 * the environment it starts with into every shell it runs, where `env` would
 * print all of it for anyone typing into the session, human or agent.
 *
 * The egress variables are passed through so a terminal that declares
 * network access can reach the broker it was given; they hold addresses and
 * certificate paths, not credentials.
 */
const SHELL_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMUX_TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "LANG",
  "LANGUAGE",
  "TERM",
  "COLORTERM",
  "TZ",
  "BERTH_EGRESS_PROXY_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

export function shellEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SHELL_ENV_ALLOWLIST.includes(key) || key.startsWith("LC_")) env[key] = value;
  }
  env.SHELL = sessionShell();
  return env;
}

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, { env: shellEnv() });
  return stdout;
}

let ttydStarted = false;
let inFlight: Promise<void> | null = null;

/**
 * `user:password` for ttyd's HTTP basic auth. Normally generated per boot by
 * the host (container.ts) and passed in, so `berth dev` can print it next to
 * the URL — the container has no way to show a human anything except a log
 * line every resident app in it can also read.
 *
 * The fallback is deliberately *not* "start without a credential": running
 * `apps/terminal` some other way (a bare `docker run`, a test harness) would
 * then quietly produce an unauthenticated writable shell, which is the exact
 * failure this closes. It generates one and logs it instead, which is
 * worse than being handed one but strictly better than none. Generated once
 * per boot, so a restarted ttyd keeps the credential already logged.
 */
let generatedCredential: string | undefined;

function credential(): string {
  const provided = process.env.BERTH_TERMINAL_CREDENTIAL;
  if (provided) return provided;
  if (!generatedCredential) {
    generatedCredential = `berth:${randomUUID()}`;
    console.warn(`[terminal] no BERTH_TERMINAL_CREDENTIAL was passed in; generated one for this boot: ${generatedCredential}`);
  }
  return generatedCredential;
}

/**
 * Lazily creates the shared tmux session (again, if it has ended) and starts
 * ttyd attached to it, both spawned as children of this already-Landlocked
 * process (see berth.yml) rather than by entrypoint.sh — unlike Xvfb for
 * browser:*, a pty needs no pre-existing display server, so there's no
 * ordering dependency forcing this earlier. That also means the shell
 * inherits whatever filesystem/network capabilities this app declared,
 * exactly like Chromium inherits apps/browser-native's.
 *
 * ttyd is started once and left running (and started again on the next call
 * if it exits) — any number of browser tabs can attach to it concurrently,
 * and (being plain
 * `tmux attach`) they all see the exact same session run_command/send_keys
 * drive, not a fresh shell per connection.
 */
export function ensureSession(): Promise<void> {
  // Concurrent calls share one check-and-create instead of each running
  // has-session and then new-session: two calls racing on the first use both
  // saw no session and both created one, and the loser failed with
  // "duplicate session". The promise is dropped once it settles, so a later
  // call checks again and a session that has since ended is recreated, and a
  // failed attempt is retried rather than remembered.
  inFlight ??= startSession().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function startSession(): Promise<void> {
  // Checked on every call, not once: a session that ended (someone typed
  // `exit`, or the shell was killed) is recreated instead of leaving every
  // later call failing for the rest of the container's life.
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
    await tmux("new-session", "-d", "-x", "500", "-y", "50", "-s", SESSION_NAME, "-c", workspaceRoot(), sessionShell()).catch(
      (err: unknown) => {
        // Someone else (a human attached over ttyd, another process on the
        // same server) created it between the check and here: it exists,
        // which is all this wanted.
        if (!/duplicate session/.test(String((err as { stderr?: string }).stderr ?? err))) throw err;
      },
    );
  }
  if (ttydStarted) return;
  ttydStarted = true;
  // No -i/--interface: ttyd's default (iface = NULL) binds all
  // interfaces, which is what Docker's port mapping needs to reach it
  // from the host — -i takes an interface *name* (e.g. "eth0") or a
  // Unix socket path, not an IP address, so there's no "0.0.0.0" form
  // of it to pass explicitly. Which is exactly why --credential is not
  // optional here: this is a *writable* shell, with every permission the
  // app's own sandbox grants it, and the only reason it isn't reachable from the LAN is that container.ts
  // binds the published port to loopback. Defence in depth, because
  // that binding is one `--publish-host` away from being widened.
  //
  // `tmux attach` per connection, so a session recreated above is the one
  // a newly opened tab attaches to.
  const ttyd = spawn("ttyd", ["--credential", credential(), "--writable", "-p", TTYD_PORT, "tmux", "attach", "-t", SESSION_NAME], {
    stdio: "ignore",
    env: shellEnv(),
  });
  // Without this, a failed spawn (e.g. ttyd missing) fires an unhandled
  // 'error' event on the ChildProcess, which Node treats as an uncaught
  // exception and takes the whole resident app process down with it —
  // the human-facing web view is best-effort, not something that should
  // be able to crash run_command/read_screen/send_keys.
  ttyd.on("error", (err) => {
    console.error(`[terminal] ttyd failed to start (the shared shell itself is unaffected): ${err}`);
  });
  // A ttyd that exits (killed, crashed) is started again on the next call
  // rather than leaving the web view dead for the rest of the container's
  // life. A spawn that failed outright emits 'error' without 'exit', so a
  // missing ttyd binary is not retried on every call.
  ttyd.on("exit", (code, signal) => {
    console.error(`[terminal] ttyd exited (${signal ?? code}); it is restarted on the next call`);
    ttydStarted = false;
  });
  ttyd.unref();
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
  await tmux("send-keys", "-t", SESSION_NAME, ...tokens);
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
  await tmux("send-keys", "-t", SESSION_NAME, marker, "Enter");

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
