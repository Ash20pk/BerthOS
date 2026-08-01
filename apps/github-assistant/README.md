# github-assistant

A resident app that talks to the GitHub API — create issues, summarize a repo — through a capability-scoped, TLS-terminating broker rather than a direct outbound connection.

This app mirrors the PRD's example manifest verbatim (including its Python `on_install` hook), so it doubles as a schema-conformance and deploy milestone check for the rest of the framework.

## Exports

| Export | Input | Output | Does |
|---|---|---|---|
| `create_issue` | `{ title: string, body: string }` | — | Opens an issue on `$GITHUB_REPO` (no-op if unset) |
| `get_repo_summary` | `{ repo: string }` | `{ summary: string, open_issues: number }` | Fetches a repo's description and open-issue count |

Without a `GITHUB_TOKEN` configured, `get_repo_summary` still returns a stub response (`"<repo> (stub — set GITHUB_TOKEN for live data)"`, `open_issues: 0`) so exports remain callable in `berth test` and local dev with no live credentials.

## Capabilities

```yaml
capabilities:
  - github:read:repos
  - github:write:issues
  - filesystem:read:/workspace
  - browser:navigate:*.github.com
  - network:connect:8092
```

Same pattern as `apps/browser-native`'s egress broker: rather than a wide-open `network:connect:*` to `api.github.com:443`, this app is scoped to only the local GitHub API broker's port. The broker (`github-api-broker.cjs`) terminates TLS itself and enforces `github:read:<scope>` vs `github:write:<scope>` — the Landlock grant just forces all traffic through it. `entrypoint.sh` sets `BERTH_GITHUB_API_PROXY` (consumed via `undici`'s `ProxyAgent`, since fetch doesn't read `HTTPS_PROXY` on its own) and `NODE_EXTRA_CA_CERTS` so the app's TLS client trusts the broker's generated leaf cert for `api.github.com`. See [docs/github-api-scoping-reference.md](../../docs/github-api-scoping-reference.md).

`GITHUB_API_BASE_URL` is a separate override used only by the milestone test's plain-HTTP mock, to exercise this app's request-shaping logic in isolation from the broker (the broker's CONNECT-only listener would otherwise reject plain HTTP).

## Running it

```bash
cd apps/github-assistant
pnpm exec berth dev
```

Set `GITHUB_TOKEN` and `GITHUB_REPO` in the environment for live API calls; omit them to run entirely on stub data.

## Testing

```bash
pnpm exec berth test
```

`on_install` runs `pip install -r requirements.txt` — the requirements file is intentionally empty (the app itself is TypeScript); it exists only so the PRD's Python `on_install` hook has something real to execute.
