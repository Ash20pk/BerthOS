// Fixture app for packages/docker-orchestrator/test/capability-enforcement.mjs's
// cross-app boundary test. Identical to boundary-app-b's source — only each
// one's berth.yml differs (scoped to its own /workspace/apps/<name>
// subdirectory only, same pattern as mesh-echo-planner/-browser). Deliberately
// no path validation of its own here: any escape must be caught by the
// kernel (Landlock), not by app code, or the test proves nothing about
// enforcement.
import { defineApp } from "@berth/sdk";
import { z } from "zod";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";

export default defineApp((app) => {
  app.export({
    name: "write_file",
    input: z.object({ path: z.string(), content: z.string() }),
    handler: async ({ path: relativePath, content }) => {
      const absolutePath = join(process.cwd(), relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf-8");
    },
  });

  // The 1.4 exploit, as an export: connect to a Unix socket by absolute path
  // and say what happened. Deliberately reports rather than throws, so the
  // test can tell "refused by the kernel" apart from "nothing was listening"
  // — an absence test that passes because the socket simply isn't there would
  // prove nothing about the boundary.
  app.export({
    name: "probe_unix_socket",
    input: z.object({ path: z.string() }),
    output: z.object({ connected: z.boolean(), code: z.string() }),
    handler: ({ path: socketPath }) =>
      new Promise((resolve) => {
        const socket = createConnection(socketPath);
        const done = (connected: boolean, code: string) => {
          socket.destroy();
          resolve({ connected, code });
        };
        socket.on("connect", () => done(true, ""));
        socket.on("error", (err: NodeJS.ErrnoException) => done(false, err.code ?? err.message));
      }),
  });

  // A full RPC round trip over an arbitrary socket path — the exploit in its
  // complete form, not just a connect(). What comes back is the *serving*
  // app's answer, so a successful call here means this app executed with that
  // app's capabilities.
  app.export({
    name: "invoke_via_socket",
    input: z.object({ path: z.string(), export: z.string(), input: z.unknown().optional() }),
    output: z.object({ response: z.string() }),
    handler: ({ path: socketPath, export: exportName, input }) =>
      new Promise((resolve) => {
        const socket = createConnection(socketPath);
        let buffer = "";
        const timer = setTimeout(() => {
          socket.destroy();
          resolve({ response: "TIMEOUT" });
        }, 5000);
        const done = (response: string) => {
          clearTimeout(timer);
          socket.destroy();
          resolve({ response });
        };
        socket.on("connect", () => socket.write(JSON.stringify({ id: "x", export: exportName, input }) + "\n"));
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf-8");
          const newline = buffer.indexOf("\n");
          if (newline !== -1) done(buffer.slice(0, newline));
        });
        socket.on("error", (err: NodeJS.ErrnoException) => done(err.code ?? err.message));
      }),
  });

  // Registers with a daemon under a name of the caller's choosing — the
  // identity half of REMEDIATION.md 1.14. Both daemons must ignore what is
  // sent here in favour of the uid the kernel reports (SO_PEERCRED).
  app.export({
    name: "register_on_bus",
    input: z.object({ app: z.string() }),
    output: z.object({ ok: z.boolean() }),
    handler: ({ app: claimed }) =>
      new Promise((resolve) => {
        const socket = createConnection("/tmp/berth-context-bus.sock");
        socket.on("connect", () => {
          // Envelope{ register: Register{ app } }: field 1 (register), then
          // field 1 (app) inside it, each length-delimited. Hand-encoded so
          // this fixture needs no protobuf dependency of its own.
          const name = Buffer.from(claimed, "utf-8");
          const register = Buffer.concat([Buffer.from([0x0a, name.length]), name]);
          const envelope = Buffer.concat([Buffer.from([0x0a, register.length]), register]);
          const header = Buffer.alloc(4);
          header.writeUInt32BE(envelope.length, 0);
          socket.write(Buffer.concat([header, envelope]));
          setTimeout(() => {
            socket.destroy();
            resolve({ ok: true });
          }, 500);
        });
        socket.on("error", () => resolve({ ok: false }));
      }),
  });

  app.export({
    name: "register_on_semantic_fs",
    input: z.object({ app: z.string(), pid: z.number() }),
    output: z.object({ ok: z.boolean() }),
    handler: ({ app: claimed, pid }) =>
      new Promise((resolve) => {
        const socket = createConnection("/tmp/berth-semantic-fs.sock");
        socket.on("connect", () => {
          const body = Buffer.from(JSON.stringify({ id: "1", op: "register", app: claimed, pid }), "utf-8");
          const header = Buffer.alloc(4);
          header.writeUInt32BE(body.length, 0);
          socket.write(Buffer.concat([header, body]));
          setTimeout(() => {
            socket.destroy();
            resolve({ ok: true });
          }, 500);
        });
        socket.on("error", () => resolve({ ok: false }));
      }),
  });

  // A 4-byte length header claiming a frame far larger than either daemon
  // will ever see. Both used to allocate exactly what it asked for
  // (REMEDIATION.md 1.14) — 4 GiB, in a root process outside any Landlock
  // domain that every app in the sandbox can reach.
  app.export({
    name: "send_oversized_frame",
    input: z.object({ path: z.string() }),
    output: z.object({ ok: z.boolean() }),
    handler: ({ path: socketPath }) =>
      new Promise((resolve) => {
        const socket = createConnection(socketPath);
        socket.on("connect", () => {
          socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff]));
          setTimeout(() => {
            socket.destroy();
            resolve({ ok: true });
          }, 500);
        });
        socket.on("error", () => resolve({ ok: false }));
      }),
  });

  app.export({
    name: "read_file",
    input: z.object({ path: z.string() }),
    output: z.object({ content: z.string() }),
    handler: async ({ path: relativePath }) => ({
      content: await readFile(join(process.cwd(), relativePath), "utf-8"),
    }),
  });
});
