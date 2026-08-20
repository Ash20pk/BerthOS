# The 30-second demo: the kernel says no

*Draft for publication — the demo script plus recording notes. The commands
are exactly the documented flow ([docs/mcp-quickstart.md](../../mcp-quickstart.md));
this file adds the timing, the framing, and the asciinema plan.*

---

## The pitch line (spoken or captioned over the recording)

> Your agent's permissions are one line in a manifest. Watch the Linux
> kernel — not a try/catch, not a system prompt — refuse a write the
> manifest doesn't cover.

## Pre-recording setup (not shown; do this before you hit record)

```bash
# 1. An enforcing host. On macOS:
berth doctor --fix                       # provisions Colima, re-checks, prints the export
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"

# 2. Warm the image so the recording never waits on a build:
berth mcp --app filesystem --app-dir apps/filesystem --warm
# run it twice; the second run finishing in seconds is your cue it's cached

# 3. Wire the bridge into Claude Code:
claude mcp add berth-filesystem \
  --env DOCKER_HOST=$DOCKER_HOST \
  -- berth mcp --app filesystem --app-dir /absolute/path/to/apps/filesystem
```

## The 30 seconds

| t | On screen | Why |
|---|---|---|
| 0–5s | `cat apps/filesystem/berth.yml` — the eye lands on `filesystem:write:/workspace` | The policy is one readable line, not a config swamp |
| 5–15s | In Claude Code: *"write hello.txt in the workspace, then write a file to /etc"* | Same tool, two targets — the agent is not in on the demo |
| 15–25s | First call: `ok`. Second call returns the block below | The contrast **is** the demo |
| 25–30s | Freeze on the `denied-by:` line | The only line that matters — read it aloud |

The denial, verbatim (this is real output, not a mock — it must match what
your recording produces):

```
BERTH CAPABILITY DENIAL
app: filesystem
raw: EACCES: permission denied, open '/etc/berth-should-not-exist.txt'
denied-by: the kernel — a Landlock ruleset compiled from "filesystem"'s
           berth.yml and applied before the app's first line ran
fix: none available — a berth.yml filesystem scope may only name
     /workspace, /context, /tmp, /app, so no declaration grants /etc/...
```

Closing caption:

> `denied-by: the kernel` is printed only when the container's own init
> reported an enforced ruleset. On a host that can't enforce, the same
> denial says so — honestly. `npm i -g @berth/cli && berth doctor` tells you
> which one you have.

## Recording notes

- **Tool:** `asciinema rec demo.cast --cols 100 --rows 28`, then
  `agg demo.cast demo.gif` for the README embed; keep the `.cast` for the
  post (players let readers copy text from it).
- **Terminal:** 100×28, dark theme, font ≥ 16pt equivalent — the denial block
  must be readable in a GIF thumbnail.
- **One take discipline:** if the warm was done, nothing in the demo takes
  more than ~3s per step. If anything stalls, stop and fix the cache — a cut
  in a 30-second trust demo reads as a trick.
- **Do not** speed up the denial output. The pause while the block prints is
  where the viewer reads `denied-by:`.
- **Verify before publishing:** the full flow is asserted end-to-end by
  [`mcp-milestone.mjs`](https://github.com/Ash20pk/BerthOS/blob/main/packages/docker-orchestrator/test/mcp-milestone.mjs)
  (real MCP SDK client, real containers, the `/etc` denial above) in
  [CI](https://github.com/Ash20pk/BerthOS/blob/main/.github/workflows/mcp-milestone.yml).
  Run it once on the recording host the same day: a demo whose test suite
  passed on a different kernel than the recording is a claim ahead of its
  artifact.

## Honesty check before this goes out

- [ ] Recording made on a host where `berth doctor` exits 0 (attach the
      doctor output to the PR that publishes the demo).
- [ ] The denial text in the post is pasted from the recording, not from
      this draft.
- [ ] If the published-package flow (`npm i -g @berth/cli`) isn't live yet,
      the caption must say "from source" — no install command we haven't
      shipped.
