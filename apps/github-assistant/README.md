# github-assistant

Gives an agent scoped access to the GitHub API: read repos and open issues, and nothing else. Every request goes through a local proxy that checks each call's method and path against the app's `github:*` capabilities.

## Run it

```bash
cd apps/github-assistant
berth dev
berth test
```

`berth` is the CLI: `npm install -g @berthos/cli`, or `node ../../packages/cli/bin/berth.js` from a clone.

The app reads two env vars:

| Env var | What it does | Without it |
|---|---|---|
| `GITHUB_TOKEN` | Token for live API calls | `get_repo_summary` returns stub data (`"<repo> (stub — set GITHUB_TOKEN for live data)"`, `open_issues: 0`) and `create_issue` sends nothing |
| `GITHUB_REPO` | `owner/name` that `create_issue` opens issues on | `create_issue` does nothing |

`berth dev` doesn't pass your shell's environment into the sandbox, so there the app runs on stub data. To make live calls, pass the values when you boot it: `berth os up gh --apps=apps/github-assistant --env GITHUB_TOKEN --env GITHUB_REPO`, which takes both from your shell, or `Computer.boot({ apps: ["apps/github-assistant"], env: { GITHUB_TOKEN, GITHUB_REPO } })` from code. The token reaches the app through a private file, not the container's environment.

## Capabilities

```yaml
capabilities:
  - github:read:repos
  - github:write:issues
  - filesystem:read:/workspace
  - browser:navigate:*.github.com
  - network:connect:8092
```

The kernel only lets the app connect to port 8092, where the GitHub API proxy listens. The proxy terminates TLS for `api.github.com` and allows or refuses each request by `github:read:<scope>` and `github:write:<scope>`. See [GitHub API scoping](../../docs/github-api-scoping-reference.md).

## Exports

| Export | Input | Output | What it does |
|---|---|---|---|
| `create_issue` | `{ title, body }` | | Opens an issue on `$GITHUB_REPO` |
| `get_repo_summary` | `{ repo }` | `{ summary, open_issues }` | Returns a repo's description and open-issue count |

The manifest's `on_install` runs `pip install -r requirements.txt`. The file is empty, because the app is TypeScript; it's there to exercise a Python `on_install` step.
