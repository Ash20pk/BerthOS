# terminal

Gives an agent a real shell that you can watch, and type into, live in your browser. The agent and you share the same session, so you see every command as it runs.

## Run it

```bash
cd apps/terminal
berth dev
berth test
```

`berth` is the CLI: `npm install -g @berthos/cli`, or `node ../../packages/cli/bin/berth.js` from a clone. Because the app declares `terminal:*`, `berth dev` prints a URL and a login:

```
[berth:dev] Terminal: http://127.0.0.1:<port>
[berth:dev]           login: berth / <generated per boot>
```

Open it to watch the session `run_command` drives. The port listens on `127.0.0.1` only and the password changes on every boot.

## Capabilities

```yaml
capabilities:
  - filesystem:write:/workspace
  - terminal:attach:*
```

- Writes are limited to `/workspace`. No `filesystem:read:*` is declared, so the shell can read files anywhere in the sandbox.
- `terminal:attach:*` starts the web terminal and lets the app open a pty. It doesn't widen what the shell can do.
- No `network:*` is declared, so the shell has no outbound network. `curl`, `git clone` and package installs fail.

Every process the shell starts inherits these rules. To keep the capability but stop `berth dev` publishing the web terminal (for example in CI), set `expose: { terminal: false }` in `berth.yml`; see the [manifest reference](../../docs/manifest-reference.md).

## Exports

| Export | Input | Output | What it does |
|---|---|---|---|
| `run_command` | `{ command }` | `{ output }` | Runs a command line in the shared shell and returns its output |
| `read_screen` | | `{ text }` | Returns what's on the terminal screen now |
| `send_keys` | `{ keys }` | | Sends tmux key names, separated by spaces (`"C-c"`, `"Up"`, `"Enter"`), not literal text. Use `run_command` for commands. |

## How it works

On first use the app starts a [tmux](https://github.com/tmux/tmux) session named `berth-terminal`, rooted at `/workspace`, and a [ttyd](https://github.com/tsl0922/ttyd) web terminal attached to the same session. Both run as children of the app, under its sandbox rules. They get a minimal environment (`PATH`, `HOME`, the user, temp-dir, locale and terminal variables, and the egress proxy variables when set), not the app's own, so the app's credentials, RPC token and declared secrets are not in the shell's environment and `env` doesn't print them.

That is defence in depth, not a boundary. The shell runs as the app's own user, in the same sandbox, with `/proc` readable, so it can still read the app process's environment from `/proc/<pid>/environ` and ttyd's command line, which carries the web terminal's credential, from `/proc/<pid>/cmdline`. Don't give the terminal app a secret you don't want whoever uses the shell, human or agent, to see.

`run_command` types the command followed by a unique marker, waits for the marker to appear on screen, and returns the text in between.

## Limits

- A command that runs longer than 15 seconds times out, and one that prints more than tmux's scrollback holds can come back partial or empty.
- One sandbox can hold only one app with a `terminal:*` capability.
