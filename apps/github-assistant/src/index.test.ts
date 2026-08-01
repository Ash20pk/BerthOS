import { test } from "node:test";
import assert from "node:assert/strict";
import app from "./index.js";

test("get_repo_summary falls back to a stub without GITHUB_TOKEN", async () => {
  delete process.env.GITHUB_TOKEN;
  const def = app._exports.get("get_repo_summary")!;
  const result = (await def.handler({ repo: "octocat/hello-world" })) as { summary: string; open_issues: number };
  assert.match(result.summary, /stub/);
  assert.equal(result.open_issues, 0);
});

test("create_issue is a no-op without GITHUB_REPO configured", async () => {
  delete process.env.GITHUB_REPO;
  const def = app._exports.get("create_issue")!;
  await def.handler({ title: "t", body: "b" });
});
