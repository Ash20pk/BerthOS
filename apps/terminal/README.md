# terminal

A resident app that gives an agent a real, shared shell — one an agent drives programmatically and a human can watch (and type into) live over the web, the same session either side touches.

## Exports

| Export | Input | Output | Does |
|---|---|---|---|
| `run_command` | `{ command: string }` | `{ output: string }` | Runs a command line in the shared shell and returns just its output |
| `read_screen` | — | `{ text: string }` | Returns the terminal's current visible screen content |
| `send_keys` | `{ keys: string }` | — | Raw pass-through to `tmux send-keys` — a whitespace-separated sequence of tmux key names (`"C-c"`, `"Up"`, `"Enter"`), not literal text. Use `run_command` for an actual command line. |

## Capabilities

```yaml
capabilities:
  - filesystem:write:/workspace
  - terminal:attach:*
```

Write is restricted to `/workspace` (same default as `apps/filesystem`), but no `filesystem:read:<path>` is declared, so reads stay at today's fully open default — a general-purpose terminal that could only `cat` inside one directory wouldn't be very useful. See [docs/capability-tokens-reference.md](../../docs/capability-tokens-reference.md).

`terminal:attach:*` isn't kernel-enforced on its own (same as `browser:*`/`github:*`) — it's the signal `@berth/docker-orchestrator`'s `container.ts` uses to map the ttyd port and `berth dev` uses to print its URL. No `network:connect:*` is declared, so the shell this spawns has **zero outbound network access** under deny-by-default — `curl`, `git clone`, `apt`-equivalents, etc. will fail unless a future version scopes in a specific port. This is a real, worth-knowing limitation, not a bug.

## How it works

Unlike `browser:*` (which needs `entrypoint.sh` to start Xvfb *before* the app's own process, so Chromium has a display to attach to), a pty has no such pre-condition — `apps/terminal` starts everything itself, lazily, on first use (`src/tmux-controller.ts`):

1. A [tmux](https://github.com/tmux/tmux) session (`berth-terminal`) is created, rooted at `/workspace`. tmux owns the actual pty.
2. [ttyd](https://github.com/tsl0922/ttyd) is spawned attached to that same session (`ttyd --credential <per-boot> --writable -p 7681 tmux attach -t berth-terminal`) — a real xterm.js terminal in the browser, no CDN dependency.

Both are spawned as children of this app's own process — the same process `agent-init` already applied a Landlock ruleset to — so the shell inherits whatever filesystem/network capabilities this app declares, exactly the way Chromium inherits `apps/browser-native`'s. There's no separate kernel-enforcement path to build for `terminal:*`.

Real system binaries, not an npm native addon (`node-pty` and friends): `berth dev` bind-mounts host-built `node_modules` straight into the (Alpine/musl) dev container, so a node-gyp-compiled binding built on a developer's own macOS/glibc-Linux host wouldn't load there at all. tmux/ttyd sidestep that entirely.

`run_command` drives the shell by sending `<command>; echo <one-off sentinel>`, then polling `tmux capture-pane` until the sentinel shows up, and returns just the text produced in between — the same technique `expect` scripts use. This is demo-grade, not a byte-exact pty parser: a command that runs longer than the internal timeout (15s), or verbose enough to overflow tmux's own scrollback before the sentinel appears, can return partial or empty output.

Because `run_command`/`send_keys` and any human watching over ttyd share the literal same tmux session, an agent running a command and a human observing over the browser see the exact same thing in real time — the terminal equivalent of watching Chromium over noVNC.

## Running it

```bash
cd apps/terminal
pnpm exec berth dev
```

Because this app declares `terminal:*`, `berth dev` prints a terminal URL:

```
[berth:dev] Terminal: http://127.0.0.1:<port>
[berth:dev]           login: berth / <generated per boot>
```

Open it to watch (and type into, `--writable` is on) the same session `run_command` drives.
