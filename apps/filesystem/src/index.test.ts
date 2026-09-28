import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// WORKSPACE_ROOT and CONTEXT_ROOT are read once at module load, so point them
// at temp directories before importing the app.
const workspace = await mkdtemp(join(tmpdir(), "filesystem-test-ws-"));
const context = await mkdtemp(join(tmpdir(), "filesystem-test-ctx-"));
process.env.BERTH_WORKSPACE_ROOT = workspace;
process.env.BERTH_CONTEXT_MOUNT = context;
const { default: app } = await import("./index.js");

test("write_file creates the directories a path names", async () => {
  await app._exports.get("write_file")!.handler({ path: "reports/2026/q4.md", content: "plan" });
  assert.equal(await readFile(join(workspace, "reports/2026/q4.md"), "utf-8"), "plan");
  const { content } = (await app._exports.get("read_file")!.handler({ path: "reports/2026/q4.md" })) as { content: string };
  assert.equal(content, "plan");
});

test("write_context_file creates the directories a path names", async () => {
  await app._exports.get("write_context_file")!.handler({ path: "findings/churn.txt", content: "week 2" });
  assert.equal(await readFile(join(context, "findings/churn.txt"), "utf-8"), "week 2");
});

test("list_files shows a directory write_file created", async () => {
  await app._exports.get("write_file")!.handler({ path: "docs/plan.md", content: "x" });
  const { files } = (await app._exports.get("list_files")!.handler(undefined)) as { files: string[] };
  assert.ok(files.includes("docs"), `expected docs in ${files.join(", ")}`);
});

test("an absolute path inside the workspace is used as written, not nested", async () => {
  const absolute = join(workspace, "calc.txt");
  await app._exports.get("write_file")!.handler({ path: absolute, content: "338350" });
  assert.equal(await readFile(absolute, "utf-8"), "338350");
  const { content } = (await app._exports.get("read_file")!.handler({ path: absolute })) as { content: string };
  assert.equal(content, "338350");
});
