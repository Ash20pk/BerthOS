import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { berthSandboxBackend, berthSandboxTools, type BerthComputerLike, type BerthTool } from "./index.js";

/**
 * Run against the real `@anthropic-ai/claude-agent-sdk` (a devDependency), not
 * a stub. The two claims this seam rests on — `tools: []` disables the host
 * built-ins, and `toolAliases` reroutes a model-emitted `Bash` — are claims
 * about that package, and a stub would let them stay true after the package
 * stopped agreeing.
 */

type Recorder = { calls: { tool: string; input: unknown }[] };

function fakeComputer(names: string[], behaviour: Record<string, (input: never) => unknown> = {}): BerthComputerLike & Recorder {
  const calls: { tool: string; input: unknown }[] = [];
  const tools: BerthTool[] = names.map((name) => ({
    name,
    description: `Berth resident app export "${name}"`,
    inputSchema: { type: "object", properties: {} },
    async invoke(input: unknown) {
      calls.push({ tool: name, input });
      const fn = behaviour[name];
      if (fn) return fn(input as never);
      return {};
    },
  }));
  return { tools, calls };
}

const contentOf = (result: { content: { text: string }[]; isError?: boolean }) => result.content[0]!.text;

describe("berthSandboxBackend", () => {
  it("disables every host built-in — the line the whole seam rests on", async () => {
    const backend = await berthSandboxBackend(fakeComputer(["run_command", "read_file", "write_file"]));
    // Built-ins execute in the harness process against the host filesystem. An
    // empty list is what stops them; a permission callback is not a substitute,
    // because it changes whether they run, not where.
    assert.deepEqual(backend.tools, []);
  });

  it("aliases the built-in names the model actually emits into the sandbox", async () => {
    const backend = await berthSandboxBackend(fakeComputer(["run_command", "read_file", "write_file"]));
    assert.deepEqual(backend.toolAliases, {
      Bash: "mcp__berth__bash",
      Read: "mcp__berth__read",
      Write: "mcp__berth__write",
      Edit: "mcp__berth__edit",
    });
    // Glob/Grep are deliberately absent: apps/filesystem has no pattern
    // matching, and a Glob that returns an unfiltered listing is worse than one
    // that isn't there.
    assert.ok(!("Glob" in backend.toolAliases));
    assert.ok(!("Grep" in backend.toolAliases));
  });

  it("keeps aliases and allowedTools derived from one serverName, never written twice", async () => {
    const backend = await berthSandboxBackend(fakeComputer(["run_command", "read_file", "write_file"]), {
      serverName: "workspace",
    });
    assert.equal(backend.toolAliases.Bash, "mcp__workspace__bash");
    assert.deepEqual(backend.allowedTools, [
      "mcp__workspace__bash",
      "mcp__workspace__read",
      "mcp__workspace__write",
      "mcp__workspace__edit",
    ]);
    assert.deepEqual(Object.keys(backend.mcpServers), ["workspace"]);
  });

  it("resolves bare export names on a single-app Computer and namespaced ones on a multi-app Computer", async () => {
    await berthSandboxBackend(fakeComputer(["run_command", "read_file", "write_file"]));
    await berthSandboxBackend(fakeComputer(["terminal__run_command", "filesystem__read_file", "filesystem__write_file"]));
    // Both forms are real — computerToolsFor() namespaces only when a Computer
    // holds more than one app — so a backend that handled one would break on
    // the other for reasons the caller could not see.
  });

  it("refuses to build, naming what was available, when the Computer lacks the apps", async () => {
    await assert.rejects(
      () => berthSandboxBackend(fakeComputer(["read_file", "write_file"])),
      (err: Error) => {
        assert.match(err.message, /needs the "run_command" export of the "terminal" app/);
        assert.match(err.message, /Available tools: read_file, write_file/);
        return true;
      },
    );
  });

  it("names the missing optional peer instead of leaking a module-not-found path", async () => {
    // Not reachable here (the package is installed), but the message is the
    // whole point of the wrapper, so it is asserted where it is constructed.
    const backend = await berthSandboxBackend(fakeComputer(["run_command", "read_file", "write_file"]));
    assert.ok(backend.mcpServers.berth, "the in-process MCP server is constructed, not a stdio subprocess");
  });
});

describe("berthSandboxBackend tool handlers", () => {
  /**
   * Exercises the handlers through the exported factory rather than reaching
   * into `createSdkMcpServer`'s returned instance — that is the SDK's internal
   * shape, and a test pinned to it would break on an SDK refactor that changed
   * nothing about this seam.
   */
  async function handlers(computer: BerthComputerLike) {
    const tools = (await berthSandboxTools(computer)) as unknown as {
      name: string;
      handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
    }[];
    assert.deepEqual(tools.map((t) => t.name).sort(), ["bash", "edit", "read", "write"]);
    return Object.fromEntries(tools.map((t) => [t.name, t.handler]));
  }

  it("routes bash to the shell app's run_command and returns its output", async () => {
    const computer = fakeComputer(["run_command", "read_file", "write_file"], {
      run_command: () => ({ output: "a.txt\nb.txt" }),
    });
    const h = await handlers(computer);
    assert.equal(contentOf(await h.bash!({ command: "ls /workspace" }, {})), "a.txt\nb.txt");
    assert.deepEqual(computer.calls, [{ tool: "run_command", input: { command: "ls /workspace" } }]);
  });

  it("surfaces a Berth denial as an error tool result, not a thrown turn", async () => {
    const computer = fakeComputer(["run_command", "read_file", "write_file"], {
      write_file: () => {
        throw new Error("EACCES: permission denied, open '/etc/passwd'");
      },
    });
    const h = await handlers(computer);
    const result = await h.write!({ path: "/etc/passwd", content: "x" }, {});

    assert.equal(result.isError, true);
    // The labelled denial is the most useful sentence in the run; letting the
    // rejection abort the harness turn would throw it away.
    assert.match(contentOf(result), /refused by the Berth sandbox: EACCES/);
  });

  it("edits by read + replace + write, so an edit is enforced exactly like a write", async () => {
    const computer = fakeComputer(["run_command", "read_file", "write_file"], {
      read_file: () => ({ content: "alpha\nbeta\n" }),
    });
    const h = await handlers(computer);
    const result = await h.edit!({ path: "/workspace/a.txt", old_string: "beta", new_string: "gamma" }, {});

    assert.equal(result.isError, undefined);
    assert.deepEqual(computer.calls, [
      { tool: "read_file", input: { path: "/workspace/a.txt" } },
      { tool: "write_file", input: { path: "/workspace/a.txt", content: "alpha\ngamma\n" } },
    ]);
  });

  it("refuses an edit whose old_string is absent or ambiguous rather than guessing", async () => {
    const computer = fakeComputer(["run_command", "read_file", "write_file"], {
      read_file: () => ({ content: "beta beta\n" }),
    });
    const h = await handlers(computer);

    const missing = await h.edit!({ path: "/w/a", old_string: "nope", new_string: "x" }, {});
    assert.equal(missing.isError, true);
    assert.match(contentOf(missing), /old_string not found/);

    const ambiguous = await h.edit!({ path: "/w/a", old_string: "beta", new_string: "x" }, {});
    assert.equal(ambiguous.isError, true);
    assert.match(contentOf(ambiguous), /occurs 2 times/);

    // Neither wrote anything — an ambiguous edit applied to the wrong line is
    // far worse than an edit that refused.
    assert.deepEqual(computer.calls.filter((c) => c.tool === "write_file"), []);
  });
});
