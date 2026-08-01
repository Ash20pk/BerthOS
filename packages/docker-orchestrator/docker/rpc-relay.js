#!/usr/bin/env node
// Piped stdin/stdout <-> a Unix socket inside the container, unchanged
// line-JSON framing on both sides. Spawned via `docker exec` (see
// ../src/relay.ts's invokeAppExport()) because the Docker Engine API has no
// way to attach to an arbitrary interior process — only the container's own
// PID 1 stdio is reachable via container.attach(). This is how the host
// reaches a specific companion app's RPC socket in multi-app-per-sandbox
// mode.
const net = require("node:net");

const socketPath = process.argv[2];
if (!socketPath) {
  console.error("usage: rpc-relay.js <socketPath>");
  process.exit(1);
}

const socket = net.createConnection(socketPath);
socket.on("connect", () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on("error", (err) => {
  console.error(`rpc-relay: ${err.message}`);
  process.exit(1);
});
socket.on("close", () => process.exit(0));
