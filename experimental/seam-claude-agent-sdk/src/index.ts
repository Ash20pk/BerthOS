/**
 * Berth as the Claude Agent SDK's sandbox backend.
 *
 * BUILD_PLAN M3.3, seam 2 — and a different shape from every seam Berth has
 * shipped so far. `berth mcp`, `toAiSdkTools`, `toLangChainTools`, and M3.3's
 * OpenAI Agents adapter all *add* Berth tools to someone else's loop, next to
 * whatever that loop already had. This one *replaces* the loop's own execution
 * surface: after `berthSandboxBackend()`, the Claude Agent SDK harness still
 * has Bash, Read, Write, and Edit, but none of them run on the host any more.
 * Every one is an RPC into a Berth sandbox whose blast radius is a manifest the
 * kernel enforces.
 *
 *   const computer = await Computer.boot({ apps: ["apps/terminal", "apps/filesystem"] });
 *   const backend = await berthSandboxBackend(computer);
 *   for await (const message of query({ prompt: "...", options: { ...backend } })) { ... }
 *
 * ## How it works, and why it is a supported hook rather than a hack
 *
 * Two documented options of `@anthropic-ai/claude-agent-sdk` do the work:
 *
 * 1. `tools: []` disables **every** built-in tool. That is the part that
 *    matters: the built-ins execute in the harness's own process, on the host
 *    filesystem, and no permission callback changes where they run. Turning
 *    them off is what makes the substitution real rather than advisory.
 * 2. `toolAliases` redirects a model-emitted built-in name to an MCP tool. The
 *    SDK's own docstring names this exact case — *"a host that runs Bash inside
 *    a remote sandbox via an MCP tool can set `{ Bash: 'mcp__workspace__bash' }`"*
 *    — so a model that emits `Bash` (because a skill document told it to, or
 *    out of habit) lands in the sandbox instead of failing as unknown.
 *
 * The MCP server is in-process (`createSdkMcpServer`), so there is no
 * subprocess, no socket, and no second place for a capability decision to be
 * made. Its four tools call the resident apps' real exports.
 *
 * ## What this does and does not buy you
 *
 * It buys the kernel tier for the harness's filesystem and shell work:
 * `filesystem:write:/workspace` in `apps/terminal`'s manifest is a Landlock
 * write domain applied before the app execs, so a `Bash` call that writes
 * outside `/workspace` gets `EACCES` from the kernel, not a refusal from a
 * model or a regex in a permission callback. `capability-enforcement.mjs`
 * in docker-orchestrator is the test behind that.
 *
 * It does not sandbox the *harness*. `query()` still runs in your process with
 * your privileges; a WebFetch, an MCP server you added yourself, or a
 * `canUseTool` callback that shells out are all outside this boundary. What is
 * inside it is exactly the four tools listed below, and `tools: []` is what
 * keeps the list from silently growing.
 *
 * `@anthropic-ai/claude-agent-sdk` is an **optional peer dependency**, imported
 * dynamically, and a devDependency here so the adapter is tested against the
 * real library rather than a hand-written idea of its shape (REMEDIATION 3.7's
 * bar for an adapter).
 */

/**
 * The shape this adapter needs from a Berth tool. Structurally identical to
 * `@berthos/agents`'s `Tool`, restated rather than imported: the agents package
 * is frozen, and a seam must not depend on it.
 */
export interface BerthTool {
  name: string;
  description: string;
  inputSchema: object;
  invoke(input: unknown, ctx?: { signal?: AbortSignal }): Promise<unknown>;
}

/**
 * The shape this adapter needs from a Berth computer: just its tool list.
 *
 * Deliberately the tool list rather than `Computer.call`, because the name a
 * tool answers to is not stable across boots. `computerToolsFor()` namespaces
 * as `<app>__<export>` when a Computer holds more than one app and uses the
 * bare `<export>` when it holds one, so a backend hard-coding either form
 * breaks on the other. Resolving against the list handles both, and turns a
 * missing app into one clear error at construction time instead of a confusing
 * "no such tool" on the model's first `Bash` call.
 */
export interface BerthComputerLike {
  tools: BerthTool[];
}

/**
 * The subset of `@anthropic-ai/claude-agent-sdk` this adapter calls, typed
 * against the real package. `import type` erases at runtime, so the package
 * stays an optional peer while `tsc` still checks these calls against the
 * actual signatures.
 */
import { z } from "zod";
import type { createSdkMcpServer as CreateSdkMcpServer, tool as SdkTool } from "@anthropic-ai/claude-agent-sdk";

type ClaudeAgentSdkModule = {
  createSdkMcpServer: typeof CreateSdkMcpServer;
  tool: typeof SdkTool;
};

export interface BerthSandboxBackendOptions {
  /**
   * Which resident app backs the shell tool. Must export `run_command`
   * (`{ command: string } -> { output: string }`), as `apps/terminal` does.
   */
  shellApp?: string;
  /**
   * Which resident app backs the file tools. Must export `read_file`,
   * `write_file`, and `list_files`, as `apps/filesystem` does.
   */
  filesystemApp?: string;
  /**
   * The MCP server name the tools are exposed under. Changing it changes the
   * generated tool names and the aliases in lockstep — they are derived from
   * this, never written twice.
   */
  serverName?: string;
}

/**
 * The tool names the Claude Agent SDK harness would otherwise execute on the
 * host. Every one is aliased into the sandbox; `tools: []` turns off the rest.
 *
 * `Glob` and `Grep` are deliberately **not** aliased. `apps/filesystem` has
 * `list_files` but no pattern matching, and a `Glob` that quietly returns an
 * unfiltered listing is worse than a `Glob` that isn't there — the model would
 * treat the result as a match set. With `tools: []` they are simply absent, and
 * the model reaches for `Bash` with `find`/`grep` inside the sandbox instead,
 * which is enforced the same way everything else here is.
 */
const ALIASED_BUILTINS = ["Bash", "Read", "Write", "Edit"] as const;

/**
 * Builds the `query()` options that put a Berth sandbox behind the Claude Agent
 * SDK's file and shell tools.
 *
 * Spread the result into `options`. It sets `tools`, `mcpServers`,
 * `toolAliases`, and `allowedTools`; everything else — `model`, `systemPrompt`,
 * `canUseTool`, `hooks`, your own MCP servers — is yours and is left alone.
 *
 * Spread it **last** if you want these to win, or spread your own `tools` after
 * it if you deliberately want some host built-ins back. The second is a real
 * choice with a real cost, so it is yours to make explicitly rather than
 * something this function decides for you: re-enabling `Write` re-enables
 * writing to the host filesystem, and the aliases will no longer be reached for
 * that name.
 */
export async function berthSandboxBackend(
  computer: BerthComputerLike,
  options: BerthSandboxBackendOptions = {},
): Promise<{
  tools: string[];
  mcpServers: Record<string, unknown>;
  toolAliases: Record<string, string>;
  allowedTools: string[];
}> {
  const { createSdkMcpServer } = await importClaudeAgentSdk();
  const serverName = options.serverName ?? "berth";
  const tools = await berthSandboxTools(computer, options);
  const qualified = (name: string) => `mcp__${serverName}__${name}`;

  return {
    // The load-bearing line. Built-ins run in the harness process on the host
    // filesystem; an empty list is what stops them, and no permission callback
    // is a substitute for it.
    tools: [],
    mcpServers: { [serverName]: createSdkMcpServer({ name: serverName, version: "0.1.0", tools }) },
    toolAliases: Object.fromEntries(ALIASED_BUILTINS.map((b) => [b, qualified(b.toLowerCase())])),
    allowedTools: ALIASED_BUILTINS.map((b) => qualified(b.toLowerCase())),
  };
}

/**
 * The four sandbox-backed tool definitions on their own, before they are wrapped
 * in an MCP server.
 *
 * Exported for two reasons. A caller who already runs an in-process MCP server
 * can add these to it rather than take a second one. And it is what makes the
 * handlers directly testable: the alternative is reaching into
 * `createSdkMcpServer`'s returned instance, which is the SDK's internal shape
 * and not something a test should be pinned to.
 */
export async function berthSandboxTools(
  computer: BerthComputerLike,
  options: BerthSandboxBackendOptions = {},
) {
  const { tool } = await importClaudeAgentSdk();
  const shellApp = options.shellApp ?? "terminal";
  const filesystemApp = options.filesystemApp ?? "filesystem";

  /**
   * Resolves `<app>__<export>` first, then the bare `<export>` a single-app
   * Computer uses (see `computerToolsFor`). Missing tools fail here, at
   * construction, naming what was available — a backend that half-exists is
   * worse than one that refuses to be built.
   */
  const resolve = (app: string, exportName: string): BerthTool => {
    const found =
      computer.tools.find((t) => t.name === `${app}__${exportName}`) ??
      computer.tools.find((t) => t.name === exportName);
    if (!found) {
      throw new Error(
        `berthSandboxBackend() needs the "${exportName}" export of the "${app}" app, which this Computer does not have. ` +
          `Boot it with that app (e.g. Computer.boot({ apps: ["apps/${app}"] })). ` +
          `Available tools: ${computer.tools.map((t) => t.name).join(", ") || "(none)"}`,
      );
    }
    return found;
  };

  const runCommand = resolve(shellApp, "run_command");
  const readFile = resolve(filesystemApp, "read_file");
  const writeFile = resolve(filesystemApp, "write_file");

  const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
  const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

  /**
   * A denial from Berth is a *result*, not a crash: it comes back as an error
   * tool result so the model can read what the kernel refused and adapt, which
   * is the whole point of the labelled-denial work (`docs/kernel-enforcement.md`).
   * Letting the rejection propagate would abort the harness turn and throw away
   * the most useful sentence in the run.
   */
  const guard = async (what: string, fn: () => Promise<unknown>) => {
    try {
      return ok(String(await fn()));
    } catch (err) {
      return fail(`${what} was refused by the Berth sandbox: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const tools = [
    tool(
      "bash",
      "Run a shell command inside the Berth sandbox. The command's filesystem and network reach is whatever the sandboxed app's berth.yml declares — anything else is refused by the kernel, not by this tool.",
      // `tool()` takes a **Zod raw shape**, not JSON Schema — asserted by the
      // suite against the real package, which rejects a JSON-schema object with
      // "inputSchema must be a Zod schema or raw shape".
      { command: z.string().describe("The shell command to run.") },
      async (args) =>
        guard("The command", async () => {
          const result = (await runCommand.invoke(args)) as { output?: string };
          return result?.output ?? "";
        }),
    ),
    tool(
      "read",
      "Read a file from inside the Berth sandbox. Reads outside the sandbox's declared read scope are refused by the kernel.",
      { path: z.string().describe("Absolute path of the file to read.") },
      async (args) =>
        guard("The read", async () => {
          const result = (await readFile.invoke(args)) as { content?: string };
          return result?.content ?? "";
        }),
    ),
    tool(
      "write",
      "Write a file inside the Berth sandbox. Writes outside the sandbox's declared write scope are refused by the kernel.",
      {
        path: z.string().describe("Absolute path of the file to write."),
        content: z.string().describe("Full contents to write."),
      },
      async (args) =>
        guard("The write", async () => {
          await writeFile.invoke(args);
          return `wrote ${(args as unknown as { path: string }).path}`;
        }),
    ),
    tool(
      "edit",
      "Replace an exact string in a file inside the Berth sandbox. Composed from read_file + write_file, so it is enforced exactly like a write.",
      {
        path: z.string().describe("Absolute path of the file to edit."),
        old_string: z.string().describe("Exact text to replace. Must occur exactly once."),
        new_string: z.string().describe("Replacement text."),
      },
      async (args) => {
        const { path, old_string, new_string } = args as unknown as {
          path: string;
          old_string: string;
          new_string: string;
        };
        return guard("The edit", async () => {
          const read = (await readFile.invoke({ path })) as { content?: string };
          const before = read?.content ?? "";
          // Match the built-in Edit's contract rather than inventing a laxer
          // one: zero matches is a typo and many matches is ambiguous, and
          // both are far better surfaced than silently applied to the wrong line.
          const occurrences = before.split(old_string).length - 1;
          if (occurrences === 0) throw new Error(`old_string not found in ${path}`);
          if (occurrences > 1) throw new Error(`old_string occurs ${occurrences} times in ${path}; it must be unique`);
          await writeFile.invoke({ path, content: before.replace(old_string, new_string) });
          return `edited ${path}`;
        });
      },
    ),
  ];

  return tools;
}

/** A single actionable error for a missing optional peer, rather than a module-not-found naming an internal path. */
async function importClaudeAgentSdk(): Promise<ClaudeAgentSdkModule> {
  try {
    return (await import("@anthropic-ai/claude-agent-sdk")) as unknown as ClaudeAgentSdkModule;
  } catch (err) {
    throw new Error(
      `berthSandboxBackend() needs the "@anthropic-ai/claude-agent-sdk" package, which ` +
        `@berthos/seam-claude-agent-sdk deliberately does not depend on — install it alongside this package ` +
        `to use the adapter. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
