import { defineApp, type ContextBusClient, type SemanticFsClient } from "@berth/sdk";
import { z } from "zod";
import { mkdir, readFile, writeFile, readdir, truncate } from "node:fs/promises";
import { createConnection } from "node:net";
import { createSocket } from "node:dgram";
import { execFile } from "node:child_process";
import { join } from "node:path";

const WORKSPACE_ROOT = process.env.BERTH_WORKSPACE_ROOT ?? "/workspace";
const CONTEXT_ROOT = process.env.BERTH_CONTEXT_MOUNT ?? "/context";

function resolveInWorkspace(relativePath: string): string {
  return join(WORKSPACE_ROOT, relativePath);
}

function resolveInContext(relativePath: string): string {
  return join(CONTEXT_ROOT, relativePath);
}

export default defineApp((app) => {
  // Captured at onAgentReady and read inside export handlers — export
  // handlers only receive `input`, not the AppContext, so publishing from
  // one requires closing over the context bus reference like this.
  let contextBus: ContextBusClient | undefined;
  let semanticFs: SemanticFsClient | undefined;

  app.export({
    name: "write_file",
    input: z.object({ path: z.string(), content: z.string() }),
    handler: async ({ path: relativePath, content }) => {
      const absolutePath = resolveInWorkspace(relativePath);
      await mkdir(WORKSPACE_ROOT, { recursive: true });
      await writeFile(absolutePath, content, "utf-8");
      await contextBus?.publish("fs.file_created", { path: relativePath, createdBy: "filesystem" });
    },
  });

  app.export({
    name: "read_file",
    input: z.object({ path: z.string() }),
    output: z.object({ content: z.string() }),
    handler: async ({ path: relativePath }) => ({
      content: await readFile(resolveInWorkspace(relativePath), "utf-8"),
    }),
  });

  app.export({
    name: "list_files",
    output: z.object({ files: z.array(z.string()) }),
    handler: async () => {
      await mkdir(WORKSPACE_ROOT, { recursive: true });
      return { files: await readdir(WORKSPACE_ROOT) };
    },
  });

  app.export({
    name: "write_context_file",
    input: z.object({ path: z.string(), content: z.string() }),
    handler: async ({ path: relativePath, content }) => {
      await mkdir(CONTEXT_ROOT, { recursive: true });
      await writeFile(resolveInContext(relativePath), content, "utf-8");
    },
  });

  app.export({
    name: "read_context_file",
    input: z.object({ path: z.string() }),
    output: z.object({ content: z.string() }),
    handler: async ({ path: relativePath }) => ({
      content: await readFile(resolveInContext(relativePath), "utf-8"),
    }),
  });

  app.export({
    name: "tag_context_file",
    input: z.object({ path: z.string(), task: z.string(), relatedApps: z.array(z.string()) }),
    handler: async ({ path: relativePath, task, relatedApps }) => {
      await semanticFs?.tag(relativePath, { task, relatedApps });
    },
  });

  app.export({
    name: "query_context",
    input: z.object({ text: z.string() }),
    output: z.object({ results: z.array(z.any()) }),
    handler: async ({ text }) => ({ results: (await semanticFs?.query(text)) ?? [] }),
  });

  app.export({
    name: "publish_context_event",
    input: z.object({ topic: z.string(), payload: z.any() }),
    handler: async ({ topic, payload }) => {
      await contextBus?.publish(topic, payload);
    },
  });

  // Diagnostic export used by capability-enforcement.mjs's truncate check.
  // Deliberately calls truncate(2) by path rather than opening the file
  // first: open(O_WRONLY) is gated by AccessFs::WriteFile, and the whole
  // point is to exercise AccessFs::Truncate on its own, which is the right
  // that used to be missing from agent-init's handled set (and so was
  // permitted everywhere, including outside every declared write path).
  app.export({
    name: "truncate_file",
    input: z.object({ path: z.string(), size: z.number() }),
    handler: async ({ path: relativePath, size }) => {
      await truncate(resolveInWorkspace(relativePath), size);
    },
  });

  // Diagnostic export used by capability-enforcement.mjs's network
  // deny-by-default check: this app declares no network:connect capability,
  // so under deny-by-default it should never be able to reach out. Always
  // registered (not conditional) — @berth/sdk's runtime.js enforces an exact
  // bijection between berth.yml's exports and the code's registered ones at
  // every boot, not just during `berth test`, so a conditionally-registered
  // export would break normal boot whenever its condition was true.
  app.export({
    name: "probe_network_connect",
    input: z.object({ host: z.string(), port: z.number() }),
    output: z.object({ connected: z.boolean(), error: z.string().optional() }),
    handler: ({ host, port }) =>
      new Promise((resolve) => {
        const socket = createConnection({ host, port, timeout: 3000 });
        socket.once("connect", () => {
          socket.destroy();
          resolve({ connected: true });
        });
        socket.once("timeout", () => {
          socket.destroy();
          resolve({ connected: false, error: "timeout" });
        });
        socket.once("error", (err) => resolve({ connected: false, error: (err as Error).message }));
      }),
  });

  // The UDP half of the same check. Landlock has no UDP access right at all,
  // so this is not testing the Landlock ruleset — it's testing the seccomp
  // filter agent-init installs for apps that declared no network capability
  // (packages/agent-init/src/seccomp.rs). Unlike the Landlock probes above,
  // this one is expected to be denied even on kernels where Landlock is
  // inactive, because seccomp-bpf is available everywhere this runs.
  app.export({
    name: "probe_network_udp",
    input: z.object({ host: z.string(), port: z.number() }),
    output: z.object({ sent: z.boolean(), error: z.string().optional() }),
    handler: ({ host, port }) =>
      new Promise((resolve) => {
        let socket: ReturnType<typeof createSocket>;
        try {
          // socket(AF_INET, SOCK_DGRAM) happens here, inside the dgram
          // handle's constructor — when the filter is installed this throws
          // synchronously rather than failing later at send().
          socket = createSocket("udp4");
        } catch (err) {
          resolve({ sent: false, error: (err as Error).message });
          return;
        }
        socket.once("error", (err) => {
          socket.close();
          resolve({ sent: false, error: err.message });
        });
        socket.send("berth-egress-probe", port, host, (err) => {
          socket.close();
          resolve(err ? { sent: false, error: err.message } : { sent: true });
        });
      }),
  });

  // Raw sockets, via the only tool in the base image that opens one: ping(8).
  // Whichever way busybox's ping goes — SOCK_RAW (needs CAP_NET_RAW, which
  // agent-init now drops) or the unprivileged ICMP SOCK_DGRAM path (which the
  // seccomp filter refuses) — a sandboxed app with no declared network
  // capability should not get a socket. Node itself has no raw-socket API, so
  // there is no in-process way to make this call.
  app.export({
    name: "probe_raw_socket",
    input: z.object({ host: z.string() }),
    output: z.object({ opened: z.boolean(), error: z.string().optional() }),
    handler: ({ host }) =>
      new Promise((resolve) => {
        execFile("ping", ["-c", "1", "-W", "1", host], { timeout: 5000 }, (err, _stdout, stderr) => {
          if (!err) {
            resolve({ opened: true });
            return;
          }
          resolve({ opened: false, error: (stderr || err.message).trim() });
        });
      }),
  });

  // Diagnostic export for capability-enforcement.mjs's namespace check
  // (REMEDIATION.md 1.3). agent-init drops CAP_SYS_ADMIN from the bounding set
  // before exec-ing this process, which is supposed to make mount(2)
  // permanently unavailable — but creating a user namespace needs no privilege
  // at all, and the kernel hands its creator a fresh CAP_FULL_SET bounding set
  // inside the new namespace. So `unshare -Urm` used to regain every capability
  // the drop had just removed, and `mount` worked again.
  //
  // Reported in two parts rather than one boolean, because they fail for
  // different reasons and the difference is the whole point: `created` is
  // whether the seccomp filter let unshare(2) through at all, `regainedCaps` is
  // whether the capability drop turned out to be reversible. A regression that
  // makes the filter too narrow shows up as created=true, regainedCaps=true; a
  // container that simply lacks the /mnt mountpoint would show created=true,
  // regainedCaps=false, which is a weaker result the test can distinguish.
  //
  // Runs via a child process because Node has no unshare(2) binding. That is
  // not a weaker test: seccomp filters are inherited across fork and execve, so
  // the busybox child is bound by exactly the filter this process carries.
  app.export({
    name: "probe_user_namespace",
    output: z.object({ created: z.boolean(), regainedCaps: z.boolean(), error: z.string().optional() }),
    handler: () =>
      new Promise((resolve) => {
        // The inner shell always exits 0 and reports through stdout markers, so
        // a failed mount inside a successfully-created namespace can't be
        // misread as unshare(2) itself having been refused — the two outcomes
        // would otherwise both surface as a non-zero exit code.
        execFile(
          "unshare",
          [
            "-Urm",
            "sh",
            "-c",
            "echo NAMESPACE_CREATED; mount -t tmpfs none /mnt 2>/dev/null && echo MOUNT_SUCCEEDED_CAP_REGAINED; exit 0",
          ],
          { timeout: 5000 },
          (err, stdout, stderr) => {
            const created = stdout.includes("NAMESPACE_CREATED");
            const regainedCaps = stdout.includes("MOUNT_SUCCEEDED_CAP_REGAINED");
            resolve(created ? { created, regainedCaps } : { created, regainedCaps, error: (stderr || err?.message || "").trim() });
          },
        );
      }),
  });

  app.onAgentReady(async (ctx) => {
    contextBus = ctx.contextBus;
    semanticFs = ctx.semanticFs;
    await ctx.contextBus.register({ app: "filesystem" });
    await ctx.semanticFs.register({ app: "filesystem" });
  });
});
