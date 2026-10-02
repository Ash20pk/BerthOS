/**
 * Every shipped resident app, driven by a real LangChain agent (OpenRouter),
 * one sandbox per group of apps that can share one:
 *
 *   W. filesystem + code-editor + activity-feed + notes  (workspace + context bus)
 *   B. browser-native + terminal                          (the two interactive apps)
 *   N. generic-connector + hello-world                    (declarative REST connector)
 *   G. github-assistant                                   (GitHub API scoping)
 *   P. hello-world-py                                     (Python SDK)
 *
 * browser-native, generic-connector, http-fetch and github-assistant each use
 * the egress proxy, and a sandbox holds only one such app, hence the split.
 *
 * As in agent.mjs, every verdict comes from an independent check: a direct
 * export call, the container itself, or its log. Never from the model's words.
 *
 *   node examples/agents/langchain-e2e/apps.mjs
 *
 * GITHUB_TOKEN and GITHUB_REPO (owner/name of a scratch repo) turn on the live
 * github-assistant scenarios; without them those are reported as not run.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { Computer, toLangChainTools } from "@berthos/agents";

const REPO = resolve(new URL("../../..", import.meta.url).pathname);
const MODEL = process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-5";
const OUT_DIR = process.env.E2E_OUT_DIR ?? join(homedir(), "berth-agent-e2e");
const ONLY = process.env.E2E_ONLY ? new Set(process.env.E2E_ONLY.split(",").map(Number)) : undefined;
const BERTH = join(REPO, "packages/cli/bin/berth.js");
const OPENROUTER = "https://openrouter.ai/api/v1";
mkdirSync(OUT_DIR, { recursive: true });

function openRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const envFile = process.env.E2E_KEY_FILE ?? join(homedir(), "berth-agent-e2e", ".env");
  for (const line of existsSync(envFile) ? readFileSync(envFile, "utf-8").split("\n") : []) {
    const m = line.match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*["']?([^"'\s]+)["']?\s*$/);
    if (m) return m[1];
  }
  throw new Error(`OPENROUTER_API_KEY not set and not found in ${envFile}`);
}
const API_KEY = openRouterKey();

// --- helpers ---------------------------------------------------------------

function inContainer(container, ...args) {
  try {
    return { ok: true, out: execFileSync("docker", ["exec", container, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}
function containerLogs(container) {
  try {
    // The apps log to stderr, which docker logs replays on its own stderr.
    return execFileSync("sh", ["-c", `docker logs ${container} 2>&1`], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
}
const flat = (s) => String(s).replace(/\s+/g, " ").trim();
const clip = (s, n = 260) => (flat(s).length > n ? `${flat(s).slice(0, n)}…` : flat(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function langChainAgent(tools) {
  const model = new ChatOpenAI({ model: MODEL, apiKey: API_KEY, temperature: 0, configuration: { baseURL: OPENROUTER } });
  return createAgent({
    model,
    tools,
    systemPrompt:
      "You are an assistant working inside a sandboxed computer. Use the tools to do what the user asks. " +
      "If a tool returns an error, report the exact error text rather than guessing, and don't retry the same call more than once. Be brief.",
  });
}

async function runLangChain(agent, prompt) {
  let result;
  try {
    result = await agent.invoke({ messages: [{ role: "user", content: prompt }] }, { recursionLimit: 30 });
  } catch (err) {
    // An agent that loops or errors is a result about the agent, not a reason
    // to skip the independent check that follows.
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { calls: [], outputs: [], answer: `(agent run failed: ${message})`, finish: "error", failed: true };
  }
  const calls = [];
  const outputs = [];
  for (const m of result.messages) {
    const type = m._getType?.() ?? m.type;
    if (type === "ai" && m.tool_calls?.length) for (const c of m.tool_calls) calls.push({ name: c.name, args: c.args });
    if (type === "tool") outputs.push({ name: m.name, content: String(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 1500) });
  }
  const last = result.messages.at(-1);
  return { calls, outputs, answer: String(last?.content ?? "").slice(0, 800), finish: last?.response_metadata?.finish_reason };
}
const used = (r, name) => r.calls.some((c) => c.name === name || c.name.endsWith(`__${name}`));
const text = (r) => r.outputs.map((o) => o.content).join("\n");
const noAgent = { calls: [], outputs: [], answer: "" };

/** A direct export call, as the independent check. Errors come back as { error }. */
async function direct(computer, name, input = {}) {
  const tool = computer.tools.find((t) => t.name === name);
  if (!tool) return { error: `no tool ${name}; have ${computer.tools.map((t) => t.name).join(", ")}` };
  try {
    return await tool.invoke(input);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// --- results ---------------------------------------------------------------

const results = [];
const booted = [];
async function scenario(s, run) {
  if (ONLY && !ONLY.has(s.id)) return;
  const started = Date.now();
  let r = noAgent;
  let verdict;
  try {
    ({ r, verdict } = await run());
  } catch (err) {
    verdict = { status: "Fail", actual: `Scenario errored: ${err instanceof Error ? err.message : String(err)}` };
  }
  const status = verdict.status ?? (verdict.pass ? "Pass" : "Fail");
  results.push({ id: s.id, group: s.group, name: s.name, steps: s.steps, expected: s.expected, status, actual: verdict.actual, note: verdict.note, toolCalls: r.calls, toolOutputs: r.outputs, answer: r.answer, ms: Date.now() - started });
  console.log(`${status.padEnd(4)}  ${String(s.id).padStart(3)}. ${s.name}  (${Date.now() - started} ms)\n        ${verdict.actual}`);
  save();
}
function save() {
  writeFileSync(join(OUT_DIR, "apps-results.json"), JSON.stringify({ model: MODEL, at: new Date().toISOString(), commit: gitHead(), sandboxes: booted, results }, null, 2));
}
function gitHead() {
  try {
    return execFileSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}
const wants = (...ids) => !ONLY || ids.some((id) => ONLY.has(id));

/** Boots one sandbox group, runs its scenarios, and always stops it. */
async function group(label, ids, apps, options, body) {
  if (!wants(...ids)) return;
  let computer;
  const started = Date.now();
  try {
    computer = await Computer.boot({ apps: apps.map((a) => join(REPO, a)), ...options });
    booted.push({ group: label, apps, container: computer.containerName, bootMs: Date.now() - started, tools: computer.tools.map((t) => t.name) });
    const agent = langChainAgent(await toLangChainTools(computer.tools));
    await body(computer, agent, computer.containerName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    booted.push({ group: label, apps, error: message });
    for (const id of ids) {
      if (!results.some((x) => x.id === id) && (!ONLY || ONLY.has(id))) {
        results.push({ id, group: label, name: `(${label} scenario ${id})`, steps: "", expected: "", status: "Fail", actual: `Sandbox failed: ${message}`, toolCalls: [], toolOutputs: [], answer: "", ms: 0 });
      }
    }
    save();
  } finally {
    await computer?.stop().catch(() => {});
  }
}

// === W. filesystem + code-editor + activity-feed + notes ====================

await group("filesystem · code-editor · activity-feed · notes", [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115], ["apps/filesystem", "apps/code-editor", "apps/activity-feed", "apps/notes"], {}, async (c, agent, box) => {
  const FS = "filesystem";
  await scenario({ id: 101, group: FS, name: "Write, read and list files", steps: "Ask the agent to write docs/plan.md, read it back and list the workspace. Check: cat in the container, direct list_files.", expected: "The file exists with the text; list_files shows docs." }, async () => {
    const r = await runLangChain(agent, 'Write "Q4 plan: ship attestation" to docs/plan.md, read it back, then list the files in the workspace.');
    const f = inContainer(box, "cat", "/workspace/docs/plan.md");
    const list = await direct(c, "filesystem__list_files");
    return { r, verdict: { pass: f.out.includes("Q4 plan: ship attestation") && JSON.stringify(list).includes("docs"), actual: `File: ${clip(f.out, 60)}; list_files: ${clip(JSON.stringify(list), 120)}` } };
  });

  await scenario({ id: 102, group: FS, name: "Write outside the workspace", steps: "Ask the agent to write ../../../etc/berth-fs.txt. Check: test -e in the container.", expected: "Refused by the kernel; the file doesn't exist." }, async () => {
    const r = await runLangChain(agent, "Write the text 'x' to the path ../../../etc/berth-fs.txt with the filesystem app and report the exact result.");
    const exists = inContainer(box, "test", "-e", "/etc/berth-fs.txt").ok;
    const d = await direct(c, "filesystem__write_file", { path: "../../../etc/berth-fs.txt", content: "x" });
    return { r, verdict: { pass: !exists && /EACCES|permission/i.test(JSON.stringify(d)), actual: `/etc/berth-fs.txt ${exists ? "EXISTS" : "absent"}; direct write: ${clip(JSON.stringify(d), 140)}` } };
  });

  await scenario({ id: 103, group: FS, name: "Share a file through /context and find it by description", steps: "Ask the agent to write a file to /context, tag it with a task and related apps, then search for it by describing it. Check: direct query_context and read_context_file.", expected: "The tagged file is found by a query about its task, and reads back intact." }, async () => {
    const r = await runLangChain(agent, "Using the filesystem app: write 'Customer churn is highest in week 2' to the context file findings/churn.txt, tag it with task 'retention analysis' and related apps ['notes'], then search the context for 'retention analysis' and tell me what you found.");
    const q = await direct(c, "filesystem__query_context", { text: "retention analysis" });
    const f = await direct(c, "filesystem__read_context_file", { path: "findings/churn.txt" });
    return { r, verdict: { pass: JSON.stringify(q).includes("churn") && JSON.stringify(f).includes("week 2"), actual: `query_context: ${clip(JSON.stringify(q), 140)}; read_context_file: ${clip(JSON.stringify(f), 80)}` } };
  });

  const CE = "code-editor";
  await scenario({ id: 104, group: CE, name: "Open a file another app wrote", steps: "Ask the agent to open docs/plan.md with the code editor. Check: direct open_file.", expected: "code-editor reads it (it declares filesystem:read:/workspace)." }, async () => {
    const r = await runLangChain(agent, "Open docs/plan.md with the code-editor app and tell me the first line.");
    const d = await direct(c, "code-editor__open_file", { path: "docs/plan.md" });
    return { r, verdict: { pass: used(r, "open_file") && JSON.stringify(d).includes("Q4 plan"), actual: `Direct open_file: ${clip(JSON.stringify(d), 100)}` } };
  });

  await scenario({ id: 105, group: CE, name: "React to a new file without being asked", steps: "Write reactive.txt with filesystem. Check: code-editor's log line in the container.", expected: "code-editor logs that it opened reactive.txt after fs.file_created, with no call to it." }, async () => {
    await direct(c, "filesystem__write_file", { path: "reactive.txt", content: "hello from filesystem" });
    let log = "";
    for (let i = 0; i < 20 && !/reactively opened "reactive.txt"/.test(log); i++) {
      await sleep(250);
      log = containerLogs(box);
    }
    const line = log.split("\n").find((l) => l.includes('reactively opened "reactive.txt"'));
    return { r: noAgent, verdict: { pass: Boolean(line), actual: line ? clip(line, 200) : "No reaction in code-editor's log within 5 s." } };
  });

  await scenario({ id: 106, group: CE, name: "Open another app's code", steps: "Ask the agent to open ../../app/apps/notes/dist/index.js with code-editor. Check: direct open_file.", expected: "Refused: code-editor may read /workspace and the system baseline, not other apps' directories." }, async () => {
    const r = await runLangChain(agent, "Use code-editor's open_file on the path ../app/apps/notes/dist/index.js and report the exact result.");
    const d = await direct(c, "code-editor__open_file", { path: "../app/apps/notes/dist/index.js" });
    return { r, verdict: { pass: /EACCES|permission/i.test(JSON.stringify(d)), actual: `Direct open_file: ${clip(JSON.stringify(d), 160)}` } };
  });

  await scenario({ id: 107, group: CE, name: "Code editor can't write", steps: "Ask the agent to save a file using only code-editor. Check: code-editor exposes no write export, and nothing was written.", expected: "No way to write: the app declares read only, and has no write export." }, async () => {
    const r = await runLangChain(agent, "Using only the code-editor app (not filesystem), save the text 'edited' to edited.txt. If code-editor can't, say so.");
    const exists = inContainer(box, "test", "-e", "/workspace/edited.txt").ok;
    const exports = c.tools.filter((t) => t.name.startsWith("code-editor__")).map((t) => t.name);
    return { r, verdict: { pass: !exists && exports.length === 1, actual: `code-editor exports: ${exports.join(", ")}; edited.txt ${exists ? "EXISTS (written via another app?)" : "absent"}. Agent: ${clip(r.answer, 120)}` } };
  });

  const NO = "notes";
  await scenario({ id: 108, group: NO, name: "Add, list and complete notes", steps: "Ask the agent to add two notes, complete one, and list them. Check: direct list_notes.", expected: "Both notes stored; the right one completed." }, async () => {
    const r = await runLangChain(agent, "Add the notes 'call supplier' and 'send invoice', then mark 'send invoice' as completed, then list all notes.");
    const d = await direct(c, "notes__list_notes");
    const notes = d?.notes ?? [];
    const invoice = notes.find((n) => n.text === "send invoice");
    const supplier = notes.find((n) => n.text === "call supplier");
    return { r, verdict: { pass: invoice?.completed === true && supplier?.completed === false, actual: `list_notes: ${clip(JSON.stringify(notes), 200)}` } };
  });

  await scenario({ id: 109, group: NO, name: "Parallel writes keep every note", steps: "Fire 30 add_note calls at once. Check: every acknowledged id is in list_notes.", expected: "30 acknowledged, 30 stored." }, async () => {
    const before = ((await direct(c, "notes__list_notes")).notes ?? []).length;
    const acks = await Promise.all(Array.from({ length: 30 }, (_, i) => direct(c, "notes__add_note", { text: `bulk ${i}` })));
    const after = ((await direct(c, "notes__list_notes")).notes ?? []).length;
    const acked = acks.filter((a) => a?.id).length;
    return { r: noAgent, verdict: { pass: acked === 30 && after - before === 30, actual: `${acked} acknowledged, ${after - before} stored.` } };
  });

  await scenario({ id: 110, group: NO, name: "Complete a note that doesn't exist", steps: "Call complete_note with an unknown id.", expected: "Returns completed: false rather than an error." }, async () => {
    const d = await direct(c, "notes__complete_note", { id: "no-such-note" });
    return { r: noAgent, verdict: { pass: d?.completed === false, actual: `complete_note: ${JSON.stringify(d)}` } };
  });

  const AF = "activity-feed";
  await scenario({ id: 111, group: AF, name: "See what other apps just did", steps: "After the file writes and notes above, ask the agent what happened recently. Check: direct get_recent_activity.", expected: "The feed holds fs.file_created, notes.added and notes.completed events." }, async () => {
    const r = await runLangChain(agent, "What happened recently in this sandbox? Use the activity feed and summarise it.");
    const d = await direct(c, "activity-feed__get_recent_activity");
    const topics = new Set((d?.events ?? []).map((e) => e.topic));
    return { r, verdict: { pass: ["fs.file_created", "notes.added", "notes.completed"].every((t) => topics.has(t)), actual: `${(d?.events ?? []).length} events; topics: ${[...topics].join(", ")}` } };
  });

  await scenario({ id: 112, group: AF, name: "Feed keeps only the latest 50", steps: "Publish 60 more events (add_note calls), then read the feed.", expected: "Exactly 50 events, newest first, the latest one on top." }, async () => {
    for (let i = 0; i < 60; i++) await direct(c, "notes__add_note", { text: `feed ${i}` });
    await sleep(1000);
    const d = await direct(c, "activity-feed__get_recent_activity");
    const events = d?.events ?? [];
    const ordered = events.every((e, i) => i === 0 || e.receivedAt <= events[i - 1].receivedAt);
    const newest = events[0]?.payload?.text;
    return { r: noAgent, verdict: { pass: events.length === 50 && ordered && newest === "feed 59", actual: `${events.length} events, newest first: ${ordered}, newest: ${newest}` } };
  });

  await scenario({ id: 113, group: "multi-app", name: "Apps can't call each other without declaring it", steps: "From inside code-editor's uid, connect to notes' RPC socket. Check: the connection is refused.", expected: "Refused: an app reaches a sibling only with app:invoke:." }, async () => {
    const socks = inContainer(box, "sh", "-c", "ls /run/berth/*/rpc.sock 2>/dev/null || find /run/berth -name '*.sock' 2>/dev/null");
    return { r: noAgent, verdict: { status: "N/A", actual: `Covered by scenario 16 (e2e-probe → filesystem socket) and by capability-enforcement Test 9. Sockets here: ${clip(socks.out, 160)}` } };
  });

  await scenario({ id: 115, group: FS, name: "Semantic search really uses embeddings", steps: "Tag a file with words unrelated to the query, then query_context with a synonym only an embedding would match. Check: the container log for embedding failures, per app.", expected: "No '[semantic-fs:embeddings] … failed' lines; the synonym query finds the file (semantic, not keyword)." }, async () => {
    await direct(c, "filesystem__write_context_file", { path: "auth-fix.md", content: "rotated the session signing key" });
    await direct(c, "filesystem__tag_context_file", { path: "auth-fix.md", task: "login token expiry bug", relatedApps: ["notes"] });
    const q = await direct(c, "filesystem__query_context", { text: "authentication credentials timing out" });
    const log = containerLogs(box);
    const failed = [...new Set(log.split("\n").filter((l) => /\[semantic-fs:embeddings\].*failed/.test(l)).map((l) => (l.match(/\/app\/apps\/([^/]+)\//) ?? [])[1] ?? "?"))];
    const found = JSON.stringify(q).includes("auth-fix");
    return { r: noAgent, verdict: { pass: failed.length === 0 && found, actual: `Embedding failures logged by: ${failed.join(", ") || "none"}. Synonym query found the file: ${found}. ${clip(JSON.stringify(q), 120)}`, note: failed.length ? "FINDING: @xenova/transformers can't load (its 'sharp' import isn't resolvable in images built by Computer.boot / berth os up), so query_context silently falls back to keyword-only ranking." : undefined } };
  });

  await scenario({ id: 114, group: FS, name: "The same four apps over MCP, one bridge each", steps: "berth mcp only serves one app per bridge; start notes over MCP and add a note from the LangChain agent. Check: the bridge's own container.", expected: "Works; notes' tools reach the agent over MCP." }, async () => {
    const client = new MultiServerMCPClient({ mcpServers: { notes: { transport: "stdio", command: "node", args: [BERTH, "mcp", "--app", "notes", "--app-dir", join(REPO, "apps/notes"), "--no-audit"] } } });
    try {
      const r = await runLangChain(langChainAgent(await client.getTools()), "Add a note 'mcp note' and then list all notes.");
      return { r, verdict: { pass: used(r, "add_note") && text(r).includes("mcp note"), actual: `Tool outputs: ${clip(text(r), 200)}` } };
    } finally {
      await client.close().catch(() => {});
    }
  });
});

// === B. browser-native + terminal ===========================================

await group("browser-native · terminal", [201, 202, 203, 204, 205, 211, 212, 213, 214, 215, 216], ["apps/browser-native", "apps/terminal"], {}, async (c, agent, box) => {
  const BR = "browser-native";
  await scenario({ id: 201, group: BR, name: "Open a page and read it", steps: "Ask the agent to open https://example.com and read the page. Check: direct get_page_text.", expected: "The page text contains 'Example Domain'." }, async () => {
    const r = await runLangChain(agent, "Open https://example.com in the browser and tell me the page's heading.");
    const d = await direct(c, "browser-native__get_page_text");
    return { r, verdict: { pass: used(r, "navigate") && JSON.stringify(d).includes("Example Domain"), actual: `get_page_text: ${clip(JSON.stringify(d), 140)}` } };
  });

  await scenario({ id: 202, group: BR, name: "Click a link", steps: "On example.com, ask the agent to click the link. Check: direct get_page_text after.", expected: "The browser follows the link to IANA's page." }, async () => {
    await direct(c, "browser-native__navigate", { url: "https://example.com" });
    const r = await runLangChain(agent, "The browser is on example.com. Click the link on the page (selector 'a'), then tell me what page you're on.");
    const d = await direct(c, "browser-native__get_page_text");
    return { r, verdict: { pass: used(r, "click") && /IANA|example domains|Internet Assigned/i.test(JSON.stringify(d)), actual: `After the click: ${clip(JSON.stringify(d), 160)}` } };
  });

  await scenario({ id: 203, group: BR, name: "Search the web", steps: "Ask the agent to search for 'Landlock LSM'. Check: direct search returns results with URLs.", expected: "Several results, each with a title and URL." }, async () => {
    const r = await runLangChain(agent, "Search the web for 'Landlock Linux security module' and give me the top two result titles and URLs.");
    const d = await direct(c, "browser-native__search", { query: "Landlock Linux security module", maxResults: 3 });
    const n = d?.results?.length ?? 0;
    return { r, verdict: { pass: n > 0 && d.results.every((x) => /^https?:/.test(x.url)), actual: `Direct search: ${n} results; ${clip(JSON.stringify(d), 200)}` } };
  });

  await scenario({ id: 204, group: BR, name: "Reach the cloud metadata address", steps: "Ask the agent to open http://169.254.169.254/latest/meta-data/. Check: direct navigate + page text.", expected: "Refused by the egress proxy: link-local addresses are never reachable, even with browser:navigate:*." }, async () => {
    const r = await runLangChain(agent, "Open http://169.254.169.254/latest/meta-data/ in the browser and report exactly what you get.");
    const nav = await direct(c, "browser-native__navigate", { url: "http://169.254.169.254/latest/meta-data/" });
    const page = await direct(c, "browser-native__get_page_text");
    const leaked = /ami-id|instance-id|iam\//.test(JSON.stringify(page));
    return { r, verdict: { pass: !leaked, actual: `navigate: ${clip(JSON.stringify(nav), 120)}; page: ${clip(JSON.stringify(page), 120)}` } };
  });

  await scenario({ id: 205, group: BR, name: "Read another app's files with file://", steps: "Ask the agent to open file:///app/apps/terminal/ (a directory, which Chromium renders as a listing) and file:///app/apps/terminal/berth.yml. Check: direct navigate + page text, and the browser's own directory as a positive control.", expected: "Another app's directory lists nothing and its berth.yml is refused (ERR_ACCESS_DENIED); the browser's own directory still lists." }, async () => {
    const r = await runLangChain(agent, "Open file:///app/apps/terminal/ in the browser and tell me which files are listed, then open file:///app/apps/terminal/berth.yml and show me what it says.");
    const page = async (url) => {
      await direct(c, "browser-native__navigate", { url: "about:blank" });
      const nav = await direct(c, "browser-native__navigate", { url });
      return { nav, text: String((await direct(c, "browser-native__get_page_text"))?.text ?? "") };
    };
    const otherDir = await page("file:///app/apps/terminal/");
    const otherFile = await page("file:///app/apps/terminal/berth.yml");
    const ownDir = await page("file:///app/apps/browser-native/");
    const listed = /berth\.yml|package\.json|dist\//.test(otherDir.text);
    const fileRead = /terminal:attach/.test(otherFile.text);
    const ownListed = /berth\.yml/.test(ownDir.text);
    return { r, verdict: { pass: !listed && !fileRead && ownListed, actual: `other app's directory lists files: ${listed}; its berth.yml readable: ${fileRead} (${clip(otherFile.nav?.error ?? otherFile.text, 90)}); own directory lists: ${ownListed}` } };
  });

  const TE = "terminal";
  await scenario({ id: 211, group: TE, name: "Run commands in the shared shell", steps: "Ask the agent to run `echo hello; pwd; id -u`. Check: direct run_command.", expected: "Output shows hello and /workspace, and a non-root uid." }, async () => {
    const r = await runLangChain(agent, "Use the terminal to run: echo hello; pwd; id -u. Report the output exactly.");
    const d = await direct(c, "terminal__run_command", { command: "echo hello; pwd; id -u" });
    const lines = String(d?.output ?? "").split(/\r?\n/).map((l) => l.trim());
    const uid = lines.find((l) => /^\d+$/.test(l));
    return { r, verdict: { pass: lines.includes("hello") && lines.includes("/workspace") && uid !== undefined && uid !== "0", actual: `run_command: ${clip(JSON.stringify(d), 160)} (uid ${uid})` } };
  });

  await scenario({ id: 212, group: TE, name: "Write outside the workspace from the shell", steps: "Ask the agent to run `touch /etc/berth-term.txt`. Check: test -e in the container.", expected: "Refused by the kernel; every process the shell starts inherits the app's rules." }, async () => {
    const r = await runLangChain(agent, "Use the terminal to run: touch /etc/berth-term.txt && echo done. Report the output exactly.");
    const exists = inContainer(box, "test", "-e", "/etc/berth-term.txt").ok;
    const d = await direct(c, "terminal__run_command", { command: "touch /etc/berth-term.txt; echo rc=$?" });
    return { r, verdict: { pass: !exists && /Permission denied|rc=1/.test(JSON.stringify(d)), actual: `/etc/berth-term.txt ${exists ? "EXISTS" : "absent"}; ${clip(JSON.stringify(d), 140)}` } };
  });

  await scenario({ id: 213, group: TE, name: "Reach the internet from the shell", steps: "Ask the agent to curl https://example.com. Check: direct run_command.", expected: "Fails: terminal declares no network capability." }, async () => {
    const r = await runLangChain(agent, "Use the terminal to run: curl -sS -m 5 https://example.com | head -3. Report the output exactly.");
    const d = await direct(c, "terminal__run_command", { command: "curl -sS -m 5 https://example.com >/dev/null; echo rc=$?" });
    return { r, verdict: { pass: /rc=[1-9]/.test(JSON.stringify(d)) && !/Example Domain/.test(text(r)), actual: `run_command: ${clip(JSON.stringify(d), 160)}` } };
  });

  await scenario({ id: 214, group: TE, name: "Signal the browser's processes from the shell", steps: "Ask the agent to kill Chromium from the terminal. Check: kill -0 on the browser app's runtime pid, run through the terminal, fails with EPERM.", expected: "Refused: the terminal's uid can't signal another app's processes." }, async () => {
    // Every app's runtime has the same command line, so find the browser app by its Chromium child.
    const pid = inContainer(box, "sh", "-c", "ps -o pid,args | grep -i chrom | grep -v grep | head -1 | awk '{print $1}'").out.trim();
    const r = await runLangChain(agent, `Use the terminal to run: kill -9 ${pid || "1"}; echo rc=$?. Report the output exactly.`);
    const d = await direct(c, "terminal__run_command", { command: `kill -0 ${pid || "1"}; echo rc=$?` });
    const alive = inContainer(box, "kill", "-0", pid || "1").ok;
    return { r, verdict: { pass: Boolean(pid) && alive && /not permitted|rc=1/.test(JSON.stringify(d)), actual: `Chromium pid ${pid || "?"} still alive: ${alive}; kill -0 from the terminal: ${clip(JSON.stringify(d), 120)}` } };
  });

  await scenario({ id: 215, group: TE, name: "Read the screen and send keys", steps: "Start `sleep 30` with send_keys-style input, interrupt it with C-c, then read_screen. Check: direct calls.", expected: "read_screen shows the shell; C-c interrupts the running command." }, async () => {
    const r = await runLangChain(agent, "Use the terminal's read_screen tool and tell me the last line on the screen.");
    await direct(c, "terminal__send_keys", { keys: "s l e e p Space 3 0 Enter" });
    await sleep(500);
    await direct(c, "terminal__send_keys", { keys: "C-c" });
    await sleep(500);
    const after = await direct(c, "terminal__run_command", { command: "echo back" });
    const screen = await direct(c, "terminal__read_screen");
    return { r, verdict: { pass: used(r, "read_screen") && /back/.test(JSON.stringify(after)) && typeof screen?.text === "string", actual: `after C-c: ${clip(JSON.stringify(after), 60)}; screen tail: ${clip(String(screen?.text ?? JSON.stringify(screen)).trim().split("\n").slice(-3).join(" | "), 160)}` } };
  });

  await scenario({ id: 216, group: TE, name: "Read other apps' files from the shell", steps: "Run `cat /app/apps/browser-native/berth.yml` and `ls /app/apps/browser-native` through the terminal, and `cat /app/apps/terminal/berth.yml` (its own) as a positive control.", expected: "Refused for another app's files; its own still readable." }, async () => {
    const other = await direct(c, "terminal__run_command", { command: "cat /app/apps/browser-native/berth.yml | head -2; ls /app/apps/browser-native 2>&1 | head -2; echo rc=$?" });
    const own = await direct(c, "terminal__run_command", { command: "head -1 /app/apps/terminal/berth.yml" });
    const leaked = /name: browser-native|package\.json|dist/.test(String(other?.output ?? ""));
    const ownOk = /name: terminal/.test(String(own?.output ?? ""));
    return { r: noAgent, verdict: { pass: !leaked && ownOk, actual: `other app: ${clip(JSON.stringify(other), 150)}; own: ${clip(JSON.stringify(own), 60)}` } };
  });
});

// === N. generic-connector + hello-world =====================================

await group("generic-connector · hello-world", [301, 302, 303, 311], ["examples/resident-apps/generic-connector", "examples/resident-apps/hello-world"], {}, async (c, agent) => {
  const GC = "generic-connector";
  await scenario({ id: 301, group: GC, name: "Call a declared REST endpoint", steps: "Ask the agent for post 1 from the connector. Check: direct get_post.", expected: "Returns status 200 and the post from jsonplaceholder.typicode.com." }, async () => {
    const r = await runLangChain(agent, "Use the connector to fetch post number 1 and tell me its title.");
    const d = await direct(c, "generic-connector-example__get_post", { id: 1 });
    return { r, verdict: { pass: d?.status === 200 && typeof d?.data?.title === "string", actual: `get_post: ${clip(JSON.stringify(d), 160)}` } };
  });

  await scenario({ id: 302, group: GC, name: "Create through a declared POST endpoint", steps: "Ask the agent to create a post. Check: direct create_post.", expected: "Returns 201 with the created post (jsonplaceholder fakes the write)." }, async () => {
    const r = await runLangChain(agent, "Use the connector to create a post titled 'Berth test' with body 'hello' for userId 1, and report the result.");
    const d = await direct(c, "generic-connector-example__create_post", { title: "Berth test", body: "hello", userId: 1 });
    return { r, verdict: { pass: d?.status === 201 && d?.data?.title === "Berth test", actual: `create_post: ${clip(JSON.stringify(d), 160)}` } };
  });

  await scenario({ id: 303, group: GC, name: "An id that doesn't exist", steps: "Call get_post with id 999999.", expected: "The API's 404 comes back as { status: 404 }, not as a thrown error." }, async () => {
    const d = await direct(c, "generic-connector-example__get_post", { id: 999999 });
    return { r: noAgent, verdict: { pass: d?.status === 404, actual: `get_post(999999): ${clip(JSON.stringify(d), 120)}` } };
  });

  await scenario({ id: 311, group: "hello-world", name: "The minimal TypeScript app answers", steps: "Ask the agent to ping hello-world. Check: direct ping.", expected: "A pong." }, async () => {
    const r = await runLangChain(agent, "Ping the hello-world app and tell me what it answers.");
    const d = await direct(c, "hello-world__ping");
    return { r, verdict: { pass: used(r, "ping") && JSON.stringify(d).length > 2 && !d?.error, actual: `ping: ${clip(JSON.stringify(d), 100)}` } };
  });
});

// === X. browser-native's network rule, through a probe with its capabilities ===

await group("network probe (browser-native's capabilities)", [206], ["examples/resident-apps/e2e-net-probe"], {}, async (c) => {
  await scenario({ id: 206, group: "browser-native", name: "Browser bypasses the proxy on another port", steps: "e2e-net-probe declares browser-native's exact capabilities. From its own process, connect to 1.1.1.1:443 directly, and to the egress proxy on 127.0.0.1:8090 as a positive control.", expected: "The direct connection is refused by the kernel (EACCES); the proxy port connects." }, async () => {
    const direct443 = await direct(c, "tcp_connect", { host: "1.1.1.1", port: 443 });
    const proxy = await direct(c, "tcp_connect", { host: "127.0.0.1", port: 8090 });
    return { r: noAgent, verdict: { pass: direct443?.connected === false && /EACCES|EPERM/.test(direct443?.error ?? "") && proxy?.connected === true, actual: `1.1.1.1:443 -> ${JSON.stringify(direct443)}; proxy 127.0.0.1:8090 -> ${JSON.stringify(proxy)}` } };
  });
});

// === GP. the GitHub API proxy's per-request decisions, through a probe ======
// e2e-gh-probe has github-assistant's exact capabilities (github:read:repos,
// github:write:issues). A fake token is enough: the proxy decides before
// anything reaches GitHub, and an allowed call reaching GitHub is shown by
// GitHub's own 401 for the fake token.

const FAKE_TOKEN = "ghp_berthE2eFakeToken000000000000000000";
await group("GitHub proxy probe (github-assistant's capabilities)", [403, 404, 405, 406], ["examples/resident-apps/e2e-gh-probe"], { env: { GITHUB_TOKEN: FAKE_TOKEN } }, async (c, _agent, box) => {
  const GH = "github-assistant";
  const req = (method, path, body = "") => direct(c, "github_request", { method, path, body });
  await scenario({ id: 403, group: GH, name: "A write the app didn't declare is refused by the GitHub proxy", steps: "DELETE /repos/Ash20pk/BerthOS and PATCH /repos/Ash20pk/BerthOS through the proxy (github:write:repos is not declared).", expected: "403 from the proxy, never forwarded." }, async () => {
    const del = await req("DELETE", "/repos/Ash20pk/BerthOS");
    const patch = await req("PATCH", "/repos/Ash20pk/BerthOS", JSON.stringify({ description: "x" }));
    return { r: noAgent, verdict: { pass: del?.status === 403 && patch?.status === 403, actual: `DELETE -> ${del?.status} ${clip(del?.body ?? del?.error, 110)}; PATCH -> ${patch?.status}` } };
  });
  await scenario({ id: 404, group: GH, name: "A read outside github:read:repos is refused", steps: "GET /user/emails and GET /user through the proxy.", expected: "403 from the proxy." }, async () => {
    const emails = await req("GET", "/user/emails");
    const user = await req("GET", "/user");
    return { r: noAgent, verdict: { pass: emails?.status === 403 && user?.status === 403, actual: `/user/emails -> ${emails?.status} ${clip(emails?.body ?? emails?.error, 110)}; /user -> ${user?.status}` } };
  });
  await scenario({ id: 406, group: GH, name: "Declared calls go through to GitHub", steps: "GET /repos/Ash20pk/BerthOS (github:read:repos) and POST /repos/Ash20pk/BerthOS/issues (github:write:issues), with a fake token.", expected: "Both forwarded: GitHub itself answers 401 Bad credentials, not the proxy's 403." }, async () => {
    const read = await req("GET", "/repos/Ash20pk/BerthOS");
    const issue = await req("POST", "/repos/Ash20pk/BerthOS/issues", JSON.stringify({ title: "x" }));
    const fromGithub = (res) => res?.status === 401 && /Bad credentials/.test(res?.body ?? "");
    return { r: noAgent, verdict: { pass: fromGithub(read) && fromGithub(issue), actual: `GET repo -> ${read?.status} ${clip(read?.body, 70)}; POST issue -> ${issue?.status} ${clip(issue?.body, 70)}` } };
  });
  await scenario({ id: 405, group: GH, name: "The token never appears in the container's environment", steps: "docker inspect the container's configured environment, and look for the token in another place a sibling could read.", expected: "Not in the container's Env; the app itself still has it." }, async () => {
    const env = execFileSync("docker", ["inspect", "-f", "{{json .Config.Env}}", box], { encoding: "utf-8" });
    const own = await direct(c, "token_in_env");
    return { r: noAgent, verdict: { pass: !env.includes(FAKE_TOKEN) && own?.present === true, actual: `token in docker Config.Env: ${env.includes(FAKE_TOKEN)}; the app has it: ${own?.present}` } };
  });
});

// === C2. code-interpreter: refusals the code caught =========================

await group("code-interpreter", [120], ["apps/code-interpreter"], {}, async (c) => {
  await scenario({ id: 120, group: "code-interpreter", name: "A refusal the code caught is still reported", steps: "Run Python that catches a PermissionError writing /etc/berth-caught.txt.", expected: "The run succeeds, and denials names the refused operation." }, async () => {
    const d = await direct(c, "run_code", { language: "python", timeout_ms: 5000, code: "try:\n    open('/etc/berth-caught.txt','w').write('x')\nexcept OSError as e:\n    print('ERROR', e)" });
    return { r: noAgent, verdict: { pass: d?.exit_code === 0 && (d?.denials ?? []).some((x) => /Permission denied/.test(x)), actual: `exit ${d?.exit_code}, denials ${JSON.stringify(d?.denials)}` } };
  });
});

// === O. operability: build cache, disk, lockfile, berth mcp start-up, os up secrets ===

if (wants(601, 602, 603, 604)) {
  const OP = "operability";
  await scenario({ id: 601, group: OP, name: "A second boot of the same apps comes from the build cache and adds no images", steps: "Computer.boot apps/notes twice (stop in between); time both and count docker images before and after.", expected: "After a warm-up boot, two more boots are fast (well under a minute) and the image count doesn't change." }, async () => {
    const count = () => Number(execFileSync("sh", ["-c", "docker images -a -q | wc -l"], { encoding: "utf-8" }).trim());
    const times = [];
    // One boot first, so the count starts from a warm cache: a first build
    // after a prune or a code change legitimately adds layers.
    await (await Computer.boot({ apps: [join(REPO, "apps/notes")] })).stop();
    const before = count();
    for (let i = 0; i < 2; i++) {
      const t0 = Date.now();
      const k = await Computer.boot({ apps: [join(REPO, "apps/notes")] });
      times.push(Date.now() - t0);
      await k.stop();
    }
    const after = count();
    return { r: noAgent, verdict: { pass: times[1] < 45_000 && after === before, actual: `boots: ${times.join(" ms, ")} ms; images ${before} -> ${after}` } };
  });
  await scenario({ id: 602, group: OP, name: "Booting sandboxes from a clone leaves the lockfile alone", steps: "git diff --quiet pnpm-lock.yaml after every boot above.", expected: "No change to the tracked lockfile." }, async () => {
    let clean = true;
    try { execFileSync("git", ["-C", REPO, "diff", "--quiet", "--", "pnpm-lock.yaml"]); } catch { clean = false; }
    return { r: noAgent, verdict: { pass: clean, actual: clean ? "pnpm-lock.yaml unchanged" : "pnpm-lock.yaml MODIFIED" } };
  });
  await scenario({ id: 603, group: OP, name: "berth mcp answers initialize at once, even while it boots", steps: "Remove berth-dev-notes, then connect an MCP client to berth mcp --app notes and time initialize, then call add_note.", expected: "initialize in a few seconds at most; the first call waits for the boot and succeeds." }, async () => {
    execFileSync("sh", ["-c", "docker rm -f berth-dev-notes >/dev/null 2>&1 || true"]);
    const client = new MultiServerMCPClient({ mcpServers: { notes: { transport: "stdio", command: "node", args: [BERTH, "mcp", "--app", "notes", "--app-dir", join(REPO, "apps/notes"), "--no-audit"] } } });
    const t0 = Date.now();
    try {
      const tools = await client.getTools();
      const initMs = Date.now() - t0;
      const out = await tools.find((t) => t.name === "add_note").invoke({ text: "cold start" });
      return { r: noAgent, verdict: { pass: initMs < 10_000 && /"id"/.test(String(out)), actual: `initialize + tools/list: ${initMs} ms; first call: ${clip(String(out), 80)}` } };
    } finally {
      await client.close().catch(() => {});
    }
  });
  await scenario({ id: 604, group: OP, name: "berth os up passes an app its declared secrets", steps: "berth os up with e2e-probe and e2e-vault, --env E2E_PROBE_TOKEN (from this shell) --env E2E_VAULT_TOKEN=...; check each app's secret_status, and the state file.", expected: "Each app sees its own secret and not the other's; the state file has no values." }, async () => {
    execFileSync("node", [BERTH, "os", "up", "sec-e2e", `--apps=${join(REPO, "examples/resident-apps/e2e-probe")},${join(REPO, "examples/resident-apps/e2e-vault")}`, "--env", "E2E_PROBE_TOKEN", "--env", "E2E_VAULT_TOKEN=vault-value-abcdef"], { cwd: REPO, env: { ...process.env, E2E_PROBE_TOKEN: "probe-value-123456" }, stdio: "ignore" });
    try {
      const k = await Computer.connect({ name: "sec-e2e" });
      const probe = await direct(k, "e2e-probe__secret_status", { name: "E2E_PROBE_TOKEN" });
      const cross = await direct(k, "e2e-probe__secret_status", { name: "E2E_VAULT_TOKEN" });
      const vault = await direct(k, "e2e-vault__secret_status", { name: "E2E_VAULT_TOKEN" });
      const state = readFileSync(join(homedir(), ".berth", "os", "sec-e2e.json"), "utf-8");
      const leaked = /probe-value|vault-value/.test(state);
      return { r: noAgent, verdict: { pass: probe?.set === true && cross?.set === false && vault?.set === true && !leaked, actual: `probe own: ${JSON.stringify(probe)}; probe sees vault's: ${JSON.stringify(cross)}; vault own: ${JSON.stringify(vault)}; values in state file: ${leaked}` } };
    } finally {
      execFileSync("node", [BERTH, "os", "down", "sec-e2e"], { cwd: REPO, stdio: "ignore" });
    }
  });
}

// === G. github-assistant =====================================================

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
await group("github-assistant", [401, 402], ["apps/github-assistant"], GITHUB_TOKEN ? { env: { GITHUB_TOKEN, GITHUB_REPO: GITHUB_REPO ?? "" } } : {}, async (c, agent, box) => {
  const GH = "github-assistant";
  const live = Boolean(GITHUB_TOKEN && GITHUB_REPO);
  await scenario({ id: 401, group: GH, name: live ? "Summarise a repo (live)" : "Summarise a repo (stub, no token)", steps: "Ask the agent for a summary of the repo. Check: direct get_repo_summary.", expected: live ? "Live description and open-issue count." : "The documented stub reply." }, async () => {
    const repo = GITHUB_REPO ?? "Ash20pk/BerthOS";
    const r = await runLangChain(agent, `Summarise the GitHub repo ${repo} and tell me how many open issues it has.`);
    const d = await direct(c, "get_repo_summary", { repo });
    const ok = live ? typeof d?.open_issues === "number" && !/stub/.test(JSON.stringify(d)) : /stub/.test(JSON.stringify(d));
    return { r, verdict: { pass: ok, actual: `get_repo_summary: ${clip(JSON.stringify(d), 160)}` } };
  });

  if (!live) {
    await scenario({ id: 402, group: GH, name: "Open an issue on the scratch repo (live)", steps: "Needs GITHUB_TOKEN and GITHUB_REPO.", expected: "" }, async () => ({ r: noAgent, verdict: { status: "N/A", actual: "Not run: needs a GitHub token and a scratch repo." } }));
    return;
  }

  await scenario({ id: 402, group: GH, name: "Open an issue on the scratch repo (live)", steps: "Ask the agent to open an issue. Check: the issue exists via the GitHub API from the host.", expected: "Issue created on GITHUB_REPO." }, async () => {
    const title = `Berth e2e ${Date.now()}`;
    const r = await runLangChain(agent, `Open a GitHub issue titled "${title}" with body "Opened by the Berth e2e suite; safe to close."`);
    const found = execFileSync("gh", ["issue", "list", "-R", GITHUB_REPO, "--search", title, "--json", "number,title", "-q", ".[0].number"], { encoding: "utf-8", env: { ...process.env, GH_TOKEN: GITHUB_TOKEN } }).trim();
    return { r, verdict: { pass: Boolean(found), actual: found ? `Issue #${found} created on ${GITHUB_REPO}.` : "No issue found." } };
  });

});

// === P. hello-world-py =======================================================

if (wants(501, 502, 503, 504)) {
  const PY = "hello-world-py";
  await scenario({ id: 501, group: PY, name: "Boot the Python app through berth mcp", steps: "berth mcp --app hello-world-py --app-dir apps/hello-world-py --warm (boots, waits for ready, stops), then list for leftover containers.", expected: "Either it boots, or it fails with a clear message and leaves nothing running (the README says berth dev doesn't pick the Python runtime yet)." }, async () => {
    let out;
    let ok = true;
    try {
      out = execFileSync("node", [BERTH, "mcp", "--app", "hello-world-py", "--app-dir", join(REPO, "apps/hello-world-py"), "--warm", "--boot-timeout", "90"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
    } catch (err) {
      ok = false;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    const lines = out.split("\n").filter((l) => l && !/berth:build|^\s+at |^\s*$/.test(l));
    const reason = lines.find((l) => /Cannot find module|exited|did not report ready|Error/.test(l)) ?? lines.slice(-1)[0];
    const leftovers = execFileSync("docker", ["ps", "-a", "--filter", "name=berth-dev-hello-world-py", "--format", "{{.Names}} ({{.Status}})"], { encoding: "utf-8" }).trim();
    execFileSync("sh", ["-c", "docker rm -f $(docker ps -aq --filter name=berth-dev-hello-world-py) >/dev/null 2>&1 || true"]);
    return {
      r: noAgent,
      verdict: {
        pass: ok,
        actual: `${ok ? "Booted." : `Failed: ${clip(reason ?? "", 200)}`} Left behind: ${leftovers || "nothing"}.`,
        note: ok ? undefined : "GAP: berth mcp (and berth dev / os up / Computer.boot) start every app with the Node runtime; a Python app needs BERTH_APP_RUNTIME=python, which only a direct startContainer() call sets. The manifest has no way to say an app is Python.",
      },
    };
  });

  await scenario({ id: 504, group: PY, name: "A Python app and a TypeScript app in one sandbox", steps: "Computer.boot code-editor + hello-world-py; call greet; publish fs.file_created from Python. Check: code-editor's log.", expected: "greet answers; code-editor receives the Python app's event." }, async () => {
    const k = await Computer.boot({ apps: [join(REPO, "apps/code-editor"), join(REPO, "apps/hello-world-py")] });
    try {
      const g = await direct(k, "hello-world-py__greet", { name: "multi" });
      await direct(k, "hello-world-py__publish_file_created", { path: "from-python.txt", created_by: "hello-world-py" });
      await sleep(1500);
      const line = containerLogs(k.containerName).split("\n").find((l) => /code-editor\].*from-python\.txt/.test(l));
      return { r: noAgent, verdict: { pass: /Hello, multi/.test(JSON.stringify(g)) && Boolean(line), actual: `greet: ${clip(JSON.stringify(g), 80)}; code-editor: ${clip(line ?? "no reaction", 120)}` } };
    } finally {
      await k.stop();
    }
  });

  for (const [id, script, name] of [
    [502, "python-sdk-milestone.mjs", "Python app boots and answers (orchestrator path)"],
    [503, "python-sdk-context-bus-milestone.mjs", "Python app talks to a TypeScript app over the context bus"],
  ]) {
    await scenario({ id, group: PY, name, steps: `node packages/docker-orchestrator/test/${script}`, expected: "The milestone passes." }, async () => {
      try {
        const out = execFileSync("node", [`test/${script}`], { cwd: join(REPO, "packages/docker-orchestrator"), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
        const tail = out.split("\n").filter((l) => /PASS|FAIL|✓|✗/.test(l)).slice(-4).join(" | ");
        return { r: noAgent, verdict: { pass: true, actual: `Exited 0. ${clip(tail, 220)}` } };
      } catch (err) {
        const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.split("\n").filter((l) => !/berth:build/.test(l)).slice(-6).join(" | ");
        return { r: noAgent, verdict: { status: "Fail", actual: `Exited ${err.status}: ${clip(out, 240)}` } };
      }
    });
  }
}

save();
const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\n${count("Pass")} passed, ${count("Fail")} failed, ${count("N/A")} not applicable, of ${results.length}. Results: ${join(OUT_DIR, "apps-results.json")}`);
process.exit(0);
