// @berthos/sdk: containers (C4 level 2). See docs/sdk-reference.md.
export default {
  name: "sdk-reference",
  w: 1160,
  h: 680,
  title: "@berthos/sdk: containers (C4 level 2)",
  boundaries: [{ x: 260, y: 20, w: 880, h: 600, label: "Sandbox" }],
  boxes: [
    { kind: "container", name: "Host CLI", type: "Container: berth rpc, berth mcp", desc: "Calls your exports from the host", x: 30, y: 120, w: 210, h: 125 },
    { kind: "external", name: "Remote client", type: "External: your own client", desc: "Calls a deployed app on E2B, Daytona or Kubernetes", x: 30, y: 360, w: 210, h: 135 },
    { kind: "container", name: "Your app", type: "Container: Node.js + @berthos/sdk", desc: "Runs dist/index.js under the kernel policy compiled from its capabilities", x: 450, y: 60, w: 240, h: 480 },
    { kind: "container", name: "Context bus daemon", type: "Container: Rust", desc: "Pub/sub between apps", x: 900, y: 40, w: 220, h: 100 },
    { kind: "container", name: "Semantic FS daemon", type: "Container: Go, mounted at /context", desc: "Tags and search", x: 900, y: 150, w: 220, h: 100 },
    { kind: "container", name: "Governing app", type: "Container: governs: true", desc: "Allows or refuses each call", x: 900, y: 260, w: 220, h: 100 },
    { kind: "container", name: "Egress proxy", type: "Container: Node.js, :8090", desc: "Allows only declared hosts", x: 900, y: 370, w: 220, h: 100 },
    { kind: "container", name: "Sibling app", type: "Container: another resident app", desc: "Declares app:invoke:<app>", x: 900, y: 480, w: 220, h: 100 },
  ],
  edges: [
    { pts: [[240, 182], [448, 182]], label: "calls exports\n[stdio, line JSON]", at: [352, 182] },
    { pts: [[240, 427], [448, 427]], label: "POST /rpc\n[HTTP, bearer token]", at: [347, 427] },
    { pts: [[690, 90], [898, 90]], label: "publish, subscribe\n[Unix socket]", at: [795, 90] },
    { pts: [[690, 200], [898, 200]], label: "tag, query\n[Unix socket]", at: [795, 200] },
    { pts: [[690, 310], [898, 310]], label: "evaluate_action first\n[Unix socket]", at: [795, 310] },
    { pts: [[690, 420], [898, 420]], label: "fetch()\n[HTTP proxy]", at: [795, 420] },
    { pts: [[900, 530], [692, 530]], label: "app:invoke\n[peers/<caller>/rpc.sock]", at: [795, 530] },
  ],
  legendKinds: [["container", "Container"], ["external", "External"]],
};
