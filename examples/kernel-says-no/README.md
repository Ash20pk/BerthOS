# `kernel-says-no`

The demo with no model in it. It boots [`apps/filesystem`](../../apps/filesystem), which declares `filesystem:write:/workspace`, and calls its `write_file` tool twice: once inside that path, once outside. The second call gets `EACCES` from the kernel.

## Run it

Needs Docker and a kernel with Landlock. No API key.

```bash
pnpm install && pnpm build      # once, from the repo root
cd examples/kernel-says-no
pnpm start                      # add 2>/dev/null to hide the Docker build output
```

## Expected output

```
--- inside the declared scope ---
write /workspace/hello.txt -> ok, read back: "hello from a sandbox"

--- outside the declared scope ---
write /etc/berth-should-not-exist.txt -> EACCES: permission denied, open '/etc/berth-should-not-exist.txt'

PASS — the capability line in berth.yml is the boundary, and the kernel is the one holding it.
```

Nothing in `index.mjs`, `@berthos/agents` or `apps/filesystem` checks that second path. The app's `berth.yml` is compiled into a [Landlock](https://docs.kernel.org/userspace-api/landlock.html) ruleset that is applied before the app's first line runs, so the write fails inside `open(2)`. A prompt-injected agent that tries the same write gets the same answer.

## Which machines enforce

Run `berth doctor` first; it tells you in one line.

| Host | Result |
|---|---|
| Linux, kernel 6.7+ | The output above: a real kernel denial. |
| macOS with Docker running in [Colima](../../docs/mac-enforcement.md) | The same. |
| macOS or Windows with Docker Desktop | The demo refuses to boot. With `BERTH_ALLOW_UNENFORCED=1 pnpm start` it boots anyway, reports `NOT ENFORCED` and exits 1, because nothing was enforced. |

## With a model in the loop

[`examples/agents/with-vercel-ai-sdk`](../agents/with-vercel-ai-sdk) is the same test with a real LLM deciding to write out of scope, driven by the Vercel AI SDK's `generateText()`.
