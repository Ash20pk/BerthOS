// Several apps in one sandbox: containers (C4 level 2). See docs/multi-app-reference.md.
export default {
  name: "multi-app-reference",
  w: 1130,
  h: 590,
  title: "Several apps in one sandbox: containers (C4 level 2)",
  boundaries: [
    { x: 20, y: 30, w: 260, h: 210, label: "Host" },
    { x: 440, y: 30, w: 670, h: 480, label: "Sandbox container", sub: "berth-dev-<primary>" },
  ],
  boxes: [
    { kind: "container", name: "berth rpc", type: "Container: CLI, or Computer.connect()", desc: "Calls one app's export from outside", x: 40, y: 60, w: 220, h: 125 },
    { kind: "container", name: "RPC relay", type: "Container: Node.js, via docker exec", desc: "Pipes stdin and stdout to one app's socket, as root", x: 470, y: 60, w: 220, h: 125 },
    { kind: "container", name: "Context bus daemon", type: "Container: Rust", desc: "Pub/sub between the apps", x: 870, y: 60, w: 220, h: 125 },
    { kind: "container", name: "App A", type: "Container: agent-init, uid 10000", desc: "Own Landlock ruleset; serves /run/berth/A/rpc.sock", x: 470, y: 330, w: 220, h: 135 },
    { kind: "container", name: "App B", type: "Container: agent-init, uid 10001", desc: "Own Landlock ruleset; declares app:invoke:A", x: 870, y: 330, w: 220, h: 135 },
  ],
  edges: [
    { pts: [[260, 122], [468, 122]], label: "docker exec\n[stdin/stdout]", at: [360, 122] },
    { pts: [[580, 185], [580, 328]], label: "rpc.sock\n[Unix socket, 0600]", at: [580, 257] },
    { pts: [[870, 397], [692, 397]], label: "peers/B/rpc.sock\n[app:invoke]", at: [780, 397] },
    { pts: [[690, 350], [760, 350], [760, 140], [868, 140]], label: "publish, subscribe\n[Unix socket]", at: [760, 262] },
    { pts: [[980, 330], [980, 187]], label: "publish, subscribe\n[Unix socket]", at: [980, 257] },
  ],
  legendKinds: [["container", "Container"]],
};
