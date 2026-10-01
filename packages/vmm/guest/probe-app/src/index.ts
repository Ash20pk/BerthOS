// A test-only resident app for the microVM e2e (scripts/e2e.mjs). It runs
// under berth-init exactly as any app does (own uid, own cgroup, agent-init's
// Landlock and seccomp), so what it observes is what an app gets:
//
//   probe     runs /usr/local/bin/berth-probe <dir> as a child, which inherits
//             the app's confinement, and returns its name=/result=/errno= lines
//   inspect   ids, cgroup, mounts and ownership of the paths that matter
//   received  context-bus events on fs.* topics delivered to this app (the
//             e2e publishes them from the filesystem app)
import { defineApp } from "@berthos/sdk";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const PATHS = ["/", "/etc", "/etc/passwd", "/usr/bin/node", "/usr/local/bin/agent-init", "/sbin/berth-init",
  "/usr/local/bin/context-bus-daemon", "/opt/berth/sdk-node", "/app", "/app/berth.yml", "/state", "/workspace", "/context", "/tmp"];

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    return `error: ${(err as NodeJS.ErrnoException).code}`;
  }
}

export default defineApp((app) => {
  const events: { topic: string; payload: unknown }[] = [];

  app.export({
    name: "probe",
    input: z.object({ dir: z.string() }),
    output: z.object({ checks: z.record(z.string()) }),
    handler: async ({ dir }) => {
      const out = execFileSync("/usr/local/bin/berth-probe", [dir], { encoding: "utf8" });
      const checks: Record<string, string> = {};
      for (const line of out.split("\n")) {
        const m = /^name=(\S+) result=(\S+) errno=(\S+)$/.exec(line);
        if (m) checks[m[1]] = m[3] === "0" ? `ok:${m[2]}` : m[3];
      }
      return { checks };
    },
  });

  app.export({
    name: "inspect",
    output: z.object({ uid: z.number() }).passthrough(),
    handler: async () => {
      const owners: Record<string, string> = {};
      for (const p of PATHS) {
        try {
          const s = statSync(p);
          owners[p] = `${s.uid}:${s.gid} ${(s.mode & 0o7777).toString(8)}`;
        } catch (err) {
          owners[p] = `error: ${(err as NodeJS.ErrnoException).code}`;
        }
      }
      const mounts = read("/proc/self/mounts")
        .split("\n")
        .filter((l) => / (\/|\/app|\/state|\/workspace|\/context|\/tmp|\/sys\/fs\/cgroup|\/etc\/passwd) /.test(l));
      return {
        uid: process.getuid?.() ?? -1,
        gid: process.getgid?.() ?? -1,
        groups: process.getgroups?.() ?? [],
        cgroup: read("/proc/self/cgroup").trim(),
        mounts,
        owners,
        passwd: read("/etc/passwd").split("\n").filter((l) => l.startsWith("berth")),
        group: read("/etc/group").split("\n").filter((l) => l.startsWith("berth")),
        cmdlineReadable: !read("/proc/cmdline").startsWith("error"),
      };
    },
  });

  app.export({
    name: "received",
    output: z.object({ events: z.array(z.any()) }),
    handler: async () => ({ events }),
  });

  app.onAgentReady(async (ctx) => {
    await ctx.contextBus.register({ app: "probe" });
    for (const topic of ["fs.file_created", "fs.context_file_created"]) {
      ctx.contextBus.subscribe(topic, (payload) => events.push({ topic, payload }));
    }
  });
});
