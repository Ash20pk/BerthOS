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
const { relativeUnder } = await import("./paths.js");

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

test("a path outside the workspace fails saying where it resolved, and how paths are read", async () => {
  // What an agent means by "/notes.txt" is usually the workspace's notes.txt;
  // it's taken as written, and the error says so. A directory that doesn't
  // exist stands in for one the sandbox refuses.
  const outside = join(await mkdtemp(join(tmpdir(), "filesystem-test-outside-")), "missing", "notes.txt");
  await assert.rejects(app._exports.get("read_file")!.handler({ path: outside }) as Promise<unknown>, (err: NodeJS.ErrnoException) => {
    assert.match(err.message, /resolves to .*missing\/notes\.txt, which is outside /);
    assert.match(err.message, /Relative paths are relative to .*an absolute path is used as written, so "\/notes\.txt" means \/notes\.txt/);
    assert.equal(err.code, "ENOENT");
    return true;
  });
  // Inside the workspace, the error is left alone.
  await assert.rejects(app._exports.get("read_file")!.handler({ path: "no-such-file.txt" }) as Promise<unknown>, (err: Error) => !/outside/.test(err.message));
});

test("a context path has one spelling for tagging, however it was written", async () => {
  // semantic-fs keys its index by the path relative to /context, which is
  // what a write through the mount records.
  for (const spelling of ["findings/churn.txt", "./findings/churn.txt", "/context/findings/churn.txt", "/context//findings/../findings/churn.txt"]) {
    assert.equal(relativeUnder("/context", spelling), "findings/churn.txt", spelling);
  }
  assert.throws(() => relativeUnder("/context", "/workspace/a.txt"), /outside \/context/);
  assert.throws(() => relativeUnder("/context", "../a.txt"), /outside \/context/);
  // The root names no file, so tagging it would index the key "".
  for (const root of ["/context", "/context/", ".", "", "findings/.."]) {
    assert.throws(() => relativeUnder("/context", root), /is \/context itself/, JSON.stringify(root));
  }
});

test("tag_context_file tags the path semantic-fs indexes the file under", async () => {
  const tagged: string[] = [];
  // onAgentReady is where the app picks up its semantic-fs client.
  const ctx = {
    contextBus: { register: async () => {}, publish: async () => {} },
    semanticFs: { register: async () => {}, tag: async (path: string) => void tagged.push(path), query: async () => [] },
  };
  for (const hook of app._onAgentReadyHooks) await hook(ctx as unknown as Parameters<typeof hook>[0]);
  await app._exports.get("tag_context_file")!.handler({ path: `${context}/findings/churn.txt`, task: "t", relatedApps: [] });
  assert.deepEqual(tagged, ["findings/churn.txt"]);

  // The context root itself is refused rather than tagged under "".
  for (const path of [context, `${context}/`]) {
    await assert.rejects(app._exports.get("tag_context_file")!.handler({ path, task: "t", relatedApps: [] }) as Promise<unknown>, /itself/);
  }
  assert.deepEqual(tagged, ["findings/churn.txt"]);
});
