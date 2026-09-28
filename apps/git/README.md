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

HTTPS only: SSH doesn't go through the sandbox's egress proxy, so `git@…` URLs don't work. A host you didn't list is refused before git runs (and by the proxy, if it got that far), and the error says so. Restart the app after editing.

## Credentials and identity

- **`GIT_TOKEN`** (secret): an access token for pushing, or for cloning private repositories. Git gets it from a credential helper whose shell reads it from the environment, so it never appears in a URL, a command line or a config file. The helper only answers for `https` and the host of the remote being used, and only clone, fetch and push have the token in their environment at all. Pass it at boot: `berth os up --env GIT_TOKEN`, or `Computer.boot({ env })`. For GitHub, a fine-grained token scoped to the repositories you want pushed to.
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

`dir` and `repo` are paths under `/workspace`, with symlinks followed. Anything that resolves outside it is refused, and `repo` has to be the top of a repository, not a directory inside one. `url` is an `https://` URL on one of the hosts in `berth.yml`.

## What it won't do

Anything else that can write `/workspace`, such as the terminal or another agent's app, can also write a repository's `.git/config`, and git runs commands a config file names. So this app treats every repository as something it didn't set up:

- **No repository settings beyond git's own.** Before each command it reads `.git/config` and refuses the repository if it sets anything other than what git writes itself on clone and `push --set-upstream` (`core.*` basics, `remote.<name>.url`/`fetch`, `branch.<name>.remote`/`merge`, `extensions.objectformat`/`refstorage`, `user.name`/`email`). That rules out filter drivers, `textconv`, `diff.external`, `core.fsmonitor`, `gpg.program`, `include.path`, `url.*.insteadOf`, `remote.*.pushurl` and `remote.*.push`, `credential.*` and `http.*`, among others. The error names the keys; remove them (`git config --local --unset-all <key>`) to go on. A repository that borrows objects from elsewhere (`objects/info/alternates`) is refused too.
- **No hooks, pagers, editors, fsmonitor or signing.** These are switched off on git's command line, which outranks any config file, and `diff` runs with `--no-ext-diff --no-textconv`.
- **No inherited environment.** Git gets `PATH`, a private `HOME`, your commit identity and nothing else from this app's environment; it reads no system or global config, so a `.gitconfig` planted in `/tmp` does nothing. `GIT_TOKEN` is only there for clone, fetch and push, which never touch the working tree: clone downloads and checks out as separate steps, and `pull` is a fetch followed by a fast-forward.
- **No force pushes.** `push` sends `refs/heads/<branch>` to the same name with no `+`, and `branch` must be a plain name, so no refspec, from the input or from the config, can rewrite a remote's history or push somewhere else.
- **HTTPS only, to the hosts you listed.** `http://`, `ssh`, `git://` and `ext::` (which runs a command as a "transport") are refused, as is a URL with credentials in it. Local paths and `file://` are refused as well: pushing to a repository on disk runs its hooks. The app's own tests turn them on with `BERTH_GIT_LOCAL_REMOTES=1`, and even then only for paths in the workspace.
- **No prompts.** A command that would ask for input fails and says what's missing.
- **No merges or rebases.** `pull` only fast-forwards; resolve anything else in the [terminal](../terminal).

The checks run before each command, so a process rewriting `.git/config` at the same moment could still slip a setting in between the check and git starting. The command-line switches above hold even then, and the token is only in the environment of the steps that don't run filters.
