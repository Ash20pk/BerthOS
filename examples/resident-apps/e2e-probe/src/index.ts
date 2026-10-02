import { defineApp } from "@berthos/sdk";
import { z } from "zod";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join } from "node:path";

const WORKSPACE = process.env.BERTH_WORKSPACE_ROOT ?? "/workspace";
// No path checks of its own: the kernel decides what this app may touch.
const resolvePath = (p: string) => (isAbsolute(p) ? p : join(WORKSPACE, p));
const code = (err: unknown) => (err as NodeJS.ErrnoException).code ?? String(err);

export default defineApp((app) => {
  app.export({
    name: "write_file",
    input: z.object({ path: z.string(), content: z.string() }),
    output: z.object({ path: z.string(), bytes: z.number() }),
    handler: async ({ path, content }) => {
      const target = resolvePath(path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf-8");
      return { path: target, bytes: Buffer.byteLength(content) };
    },
  });

  app.export({
    name: "read_file",
    input: z.object({ path: z.string() }),
    output: z.object({ content: z.string() }),
    handler: async ({ path }) => ({ content: (await readFile(resolvePath(path), "utf-8")).slice(0, 2000) }),
  });

  app.export({
    name: "probe_socket",
    input: z.object({ path: z.string() }),
    output: z.object({ connected: z.boolean(), code: z.string() }),
    handler: ({ path }) =>
      new Promise((resolve) => {
        const s = createConnection(path);
        s.once("connect", () => (s.destroy(), resolve({ connected: true, code: "connected" })));
        s.once("error", (err) => resolve({ connected: false, code: code(err) }));
      }),
  });

  app.export({
    name: "list_processes",
    output: z.object({ processes: z.array(z.object({ pid: z.number(), cmd: z.string() })) }),
    handler: async () => {
      const out: { pid: number; cmd: string }[] = [];
      for (const entry of await readdir("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const cmd = await readFile(`/proc/${entry}/cmdline`, "utf-8").catch(() => "");
        if (cmd) out.push({ pid: Number(entry), cmd: cmd.split("\0").join(" ").trim().slice(0, 120) });
      }
      return { processes: out };
    },
  });

  // Signal 0 checks permission to signal without delivering anything, so a
  // successful probe doesn't kill the target.
  app.export({
    name: "signal_process",
    input: z.object({ pid: z.number() }),
    output: z.object({ allowed: z.boolean(), code: z.string() }),
    handler: async ({ pid }) => {
      try {
        process.kill(pid, 0);
        return { allowed: true, code: "allowed" };
      } catch (err) {
        return { allowed: false, code: code(err) };
      }
    },
  });

  app.export({
    name: "read_process_env",
    input: z.object({ pid: z.number() }),
    output: z.object({ content: z.string() }),
    handler: async ({ pid }) => ({ content: (await readFile(`/proc/${pid}/environ`, "utf-8")).split("\0").join("\n").slice(0, 2000) }),
  });

  // Reports whether a variable is set and how long it is, never its value.
  app.export({
    name: "secret_status",
    input: z.object({ name: z.string() }),
    output: z.object({ set: z.boolean(), length: z.number() }),
    handler: async ({ name }) => ({ set: process.env[name] !== undefined, length: process.env[name]?.length ?? 0 }),
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "e2e-probe" });
  });
});
