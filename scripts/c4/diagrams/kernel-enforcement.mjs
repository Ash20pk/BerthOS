export default {
  name: "kernel-enforcement",
  w: 1000,
  h: 790,
  title: "Enforcement: containers (C4 level 2)",
  boundaries: [
    { x: 20, y: 30, w: 580, h: 440, label: "Sandbox" },
  ],
  boxes: [
    { kind: "container", name: "Resident app", type: "Container: one uid per app", desc: "Declares capabilities in berth.yml", x: 40, y: 60, w: 540, h: 125 },
    { kind: "container", name: "Egress proxy", type: "Container: Node.js, 127.0.0.1:8090", desc: "browser:navigate / network:host: hostnames only", x: 40, y: 300, w: 240, h: 125 },
    { kind: "container", name: "GitHub API proxy", type: "Container: Node.js, 127.0.0.1:8092", desc: "github:read / github:write: method and path", x: 340, y: 300, w: 240, h: 125 },
    { kind: "external", name: "Kernel", type: "Landlock + seccomp", desc: "Files, outbound ports, binds, socket types, io_uring, namespaces", x: 720, y: 60, w: 250, h: 125 },
    { kind: "external", name: "Internet hosts", type: "External System", desc: "Only those a declared pattern covers", x: 40, y: 580, w: 240, h: 110 },
    { kind: "external", name: "api.github.com", type: "External System", desc: "Only routes a declared scope covers", x: 340, y: 580, w: 240, h: 110 },
  ],
  edges: [
    { pts: [[160, 185], [160, 298]], label: "CONNECT host:port\n[HTTP proxy]", at: [160, 242] },
    { pts: [[460, 185], [460, 298]], label: "CONNECT api.github.com\n[TLS ends at the proxy]", at: [460, 242] },
    { pts: [[580, 122], [718, 122]], dashed: true, label: "checked\nin-kernel", at: [649, 122] },
    { pts: [[160, 425], [160, 578]], label: "allowed only\n[TCP]", at: [160, 525] },
    { pts: [[460, 425], [460, 578]], label: "allowed only\n[TLS]", at: [460, 525] },
  ],
  legendKinds: [["container", "Container"], ["external", "External"]],
};
