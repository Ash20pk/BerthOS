# Your agent's API key is not its sidekick's API key

*Draft for publication — BUILD_PLAN M1.3, per-app secret scoping.*

---

Multi-app agent sandboxes have a quiet default: every app in the container
shares one environment. The research agent you gave `GITHUB_TOKEN` to is
sitting next to a scratch app that never asked for it — and in most stacks,
that scratch app can just read it.

Berth's manifest now closes this with one line:

```yaml
secrets:
  - GITHUB_TOKEN
```

Declared names leave the container's shared secrets file entirely and are
delivered only to declaring apps — each through its own `0600` file owned by
that app's uid, sourced only in that app's own process tree.

## What "can't read it" means concretely

Three doors, all tested shut in
[`per-app-secrets-milestone.mjs`](https://github.com/Ash20pk/BerthOS/blob/main/packages/docker-orchestrator/test/per-app-secrets-milestone.mjs):

- **env**: the sibling's process environment simply doesn't contain it.
- **`/proc/<pid>/environ`**: per-app uids make the kernel refuse the read —
  and container root itself lacks `CAP_SYS_PTRACE`, so even `docker exec`'s
  root can't read a live process's environment this way.
- **The file's DAC**: `0600`, owned by the declaring app's uid.

Plus the positive control (the app *can* read its own file) and — our house
rule — a control boot with no declaration where the token demonstrably
reaches both apps, proving the isolation assertions can fail.

## What it doesn't do (the honest part)

- An **undeclared** secret keeps today's shared behavior — declare it to
  scope it. Compatibility is explicit, not accidental.
- The pre-enforcement root daemons can still read any file in the container —
  threat model B4, the next milestone's target.
- Root via the Docker socket reads everything. It always did.

One line in a manifest; the kernel and file modes hold it; a milestone test
in CI proves it — including the run where it's allowed to fail.
