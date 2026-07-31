import { defineApp } from "@berth/sdk";
import { z } from "zod";

const GITHUB_API = "https://api.github.com";

/** Returns null if no live credentials are configured, so exports still work (with stub data) in `berth test` and local dev without a token. */
async function githubFetch(path: string, init?: RequestInit): Promise<any | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  return res.json();
}

export default defineApp((app) => {
  app.export({
    name: "create_issue",
    input: z.object({ title: z.string(), body: z.string() }),
    handler: async ({ title, body }) => {
      const repo = process.env.GITHUB_REPO;
      if (!repo) return; // no repo configured — no-op, matches this export's PRD-defined input shape (repo isn't part of it)
      await githubFetch(`/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title, body }) });
    },
  });

  app.export({
    name: "get_repo_summary",
    input: z.object({ repo: z.string() }),
    output: z.object({ summary: z.string(), open_issues: z.number() }),
    handler: async ({ repo }) => {
      const data = await githubFetch(`/repos/${repo}`);
      if (!data) {
        return { summary: `${repo} (stub — set GITHUB_TOKEN for live data)`, open_issues: 0 };
      }
      return { summary: data.description ?? repo, open_issues: data.open_issues_count ?? 0 };
    },
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "github-assistant" });
  });
});
