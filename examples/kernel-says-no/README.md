# `kernel-says-no`

The demo with no model in it. One resident app that declares
`filesystem:write:/workspace`, two calls to its `write_file` tool: one inside
that path, one outside. The second returns `EACCES` from the kernel.

```
--- inside the declared scope ---
write /workspace/hello.txt -> ok, read back: "hello from a sandbox"

--- outside the declared scope ---
write /etc/berth-should-not-exist.txt -> EACCES: permission denied, open '/etc/berth-should-not-exist.txt'

PASS — the capability line in berth.yml is the boundary, and the kernel is the one holding it.
```

Nothing in `index.mjs`, in `@berth/agents`, or in `apps/filesystem`'s own code
inspects that second path. `apps/filesystem/berth.yml`'s capability list is
compiled into a [Landlock](https://docs.kernel.org/userspace-api/landlock.html)
ruleset that `agent-init` applies before the app's first line runs, so the write
fails in `open(2)`. That is why an agent that was prompt-injected into trying it
gets the same answer as this script does.

## Run it

```bash
pnpm install && pnpm build      # from the repo root, once — @berth/* is not on npm yet
cd examples/kernel-says-no
pnpm start                      # docker build chatter goes to stderr; add 2>/dev/null for just the demo
```

## It needs a kernel that has Landlock

Run `berth doctor` first; it answers this in one line.

| Host | What this example does |
|------|------------------------|
| Linux, kernel 5.13+ | Runs as shown above — a real kernel denial |
| macOS, Docker daemon in [Colima](../../docs/mac-enforcement.md) | Same — verified on Apple silicon, Landlock ABI 4 |
| macOS / Windows (Docker Desktop) | `Computer.boot()` refuses to run unrestricted. `BERTH_ALLOW_UNENFORCED=1 pnpm start` boots anyway and the script reports `NOT ENFORCED` and exits 1, because on that host nothing was applied |

The last row is the point of the exercise as much as the first: the failure mode
this project cares about is a sandbox that looks enforced and isn't, so the
example exits non-zero rather than printing a denial it cannot attribute to the
kernel. [docs/mac-enforcement.md](../../docs/mac-enforcement.md) is a
four-flag Colima recipe that turns a Mac into the second row — no kernel build.

## Want the same thing with a model in the loop?

[`examples/agents/with-vercel-ai-sdk`](../agents/with-vercel-ai-sdk) is this
demo with a real LLM deciding to write out of scope, driven by
`generateText()` with no Berth `Agent` anywhere in it.
