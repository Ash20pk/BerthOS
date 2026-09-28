# git

Git inside the sandbox's workspace: clone, branch, commit, diff, push and pull, over HTTPS to the git hosts you list and nowhere else. A coding agent gets version control without getting the network: the rest of the sandbox still can't reach anything.

## Run it

```bash
cd apps/git
berth dev
berth test
```

`berth` is the CLI: `npm install -g @berthos/cli`, or `node ../../packages/cli/bin/berth.js` from a clone. As MCP tools: `berth mcp --app git --app-dir apps/git`. The image installs git at build time (`on_install: apk add git`), so the first build needs network access.

## Choose the hosts

It ships with `network:host:github.com`. Add your own in `berth.yml`, one per host:

```yaml
capabilities:
  - filesystem:write:/workspace
  - network:host:github.com
  - network:host:gitlab.example.com
  - network:connect:8090
```

HTTPS only: SSH doesn't go through the sandbox's egress proxy, so `git@…` URLs don't work. A host you didn't list is refused by the proxy, and the error says so. Restart the app after editing.

## Credentials and identity

- **`GIT_TOKEN`** (secret): an access token for pushing, or for cloning private repositories. Git gets it from a credential helper whose shell reads it from the environment, so it never appears in a URL, a command line or a config file, and it only goes to hosts the proxy lets through. Pass it at boot: `berth os up --env GIT_TOKEN`, or `Computer.boot({ env })`. For GitHub, a fine-grained token scoped to the repositories you want pushed to.
- **`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`**: who commits are made as. Default `Berth agent <agent@berth.invalid>`.

## Exports

| Export | Input | Output |
|---|---|---|
| `clone` | `{ url, dir }` | `{ path, branch, head }` |
| `status` | `{ repo }` | `{ branch, ahead, behind, changes: [{ path, status }] }` |
| `diff` | `{ repo, staged }` | `{ diff, truncated }` |
| `log` | `{ repo, limit }` | `{ commits: [{ sha, author, date, subject }] }` |
| `branch` | `{ repo, name, create }` | `{ branch }`: switch to a branch, or create it |
| `add` | `{ repo, paths }` | `{ staged }`: `["."]` stages everything |
| `commit` | `{ repo, message }` | `{ sha, summary }` |
| `push` | `{ repo, branch }` | `{ output }`: to `origin`, setting upstream |
| `pull` | `{ repo }` | `{ output, head }`: fast-forward only |

`dir` and `repo` are paths under `/workspace`. Anything that resolves outside it is refused.

## What it won't do

- **No force pushes.** `branch` must be a plain name, so no `+ref` or `src:dst` refspec can rewrite a remote's history or push somewhere else.
- **No hooks.** Git runs with hooks disabled, so a hook planted by another app that can write `/workspace` never runs with this app's network access.
- **No command transports.** Only `https`, `http` and `file` are allowed; `ext::`, which runs a command as a "transport", and `ssh`/`git://` are refused.
- **No prompts.** A command that would ask for input fails and says what's missing.
- **No merges or rebases.** `pull` only fast-forwards; resolve anything else in the [terminal](../terminal).
