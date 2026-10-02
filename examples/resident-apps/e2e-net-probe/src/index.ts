import { defineApp } from "@berthos/sdk";
import { z } from "zod";
import { createConnection } from "node:net";

export default defineApp((app) => {
  app.export({
    name: "tcp_connect",
    input: z.object({ host: z.string(), port: z.number() }),
    output: z.object({ connected: z.boolean(), error: z.string() }),
    handler: ({ host, port }) =>
      new Promise((resolve) => {
        const socket = createConnection({ host, port, timeout: 4000 });
        socket.once("connect", () => { socket.destroy(); resolve({ connected: true, error: "" }); });
        socket.once("timeout", () => { socket.destroy(); resolve({ connected: false, error: "timeout" }); });
        socket.once("error", (err) => resolve({ connected: false, error: `${(err as NodeJS.ErrnoException).code ?? ""} ${err.message}`.trim() }));
      }),
  });
});
