export default {
  name: "mesh-reference",
  w: 1080,
  h: 720,
  title: "Mesh networking: containers (C4 level 2)",
  boundaries: [
    { x: 20, y: 30, w: 320, h: 390, label: "Sandbox container", sub: "berth-dev-planner" },
    { x: 720, y: 30, w: 320, h: 390, label: "Sandbox container", sub: "berth-dev-browser" },
    { x: 370, y: 480, w: 320, h: 190, label: "Host" },
  ],
  boxes: [
    { kind: "container", name: "Resident app", type: "Container: Node.js or Python", desc: "Declares network:peer:berth-dev-browser", x: 50, y: 60, w: 260, h: 120 },
    { kind: "container", name: "mesh-daemon", type: "Container: Rust, root + NET_ADMIN", desc: "Owns the key pair and wg0; applies the roster", x: 50, y: 260, w: 260, h: 120 },
    { kind: "container", name: "Resident app", type: "Container: Node.js or Python", desc: "Declares network:peer:berth-dev-planner and network:bind:9000", x: 750, y: 60, w: 260, h: 120 },
    { kind: "container", name: "mesh-daemon", type: "Container: Rust, root + NET_ADMIN", desc: "Owns the key pair and wg0; applies the roster", x: 750, y: 260, w: 260, h: 120 },
    { kind: "container", name: "mesh-coordinator", type: "Container: Node.js, SQLite, :4875", desc: "Hands out mesh IPs, stores public keys, matches patterns both ways", x: 400, y: 505, w: 260, h: 125 },
  ],
  edges: [
    { pts: [[310, 120], [748, 120]], label: "connects to mesh IP:port\n[TCP over wg0]", at: [530, 120] },
    { pts: [[312, 320], [748, 320]], both: true, label: "WireGuard tunnel\n[UDP 51820]", at: [530, 320] },
    { pts: [[290, 380], [290, 567], [398, 567]], label: "register, roster\nevery 5 s [HTTP(S)]", at: [290, 455] },
    { pts: [[990, 380], [990, 567], [662, 567]], label: "register, roster\nevery 5 s [HTTP(S)]", at: [990, 455] },
  ],
  legendKinds: [["container", "Container"]],
};
