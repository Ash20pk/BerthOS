export default {
  name: "egress-broker",
  w: 1040,
  h: 590,
  title: "Egress broker: containers (C4 level 2)",
  boundaries: [
    { x: 20, y: 30, w: 260, h: 440, label: "Sandbox" },
    { x: 400, y: 280, w: 260, h: 190, label: "Host", sub: "microVM only" },
  ],
  boxes: [
    { kind: "container", name: "Resident app", type: "Container: Node.js or Chromium", desc: "Declares network:host:<pattern> and network:connect:8090", x: 40, y: 60, w: 220, h: 125 },
    { kind: "container", name: "Egress broker", type: "Container: Node.js, 127.0.0.1:8090", desc: "Checks host and port against the app's patterns, refuses internal addresses", x: 40, y: 300, w: 220, h: 135 },
    { kind: "container", name: "Host dialer", type: "Container: in berth-vmm", desc: "Its own allowlist and internal-address refusal", x: 420, y: 300, w: 220, h: 125 },
    { kind: "external", name: "Kernel", type: "Landlock + seccomp", desc: "Allows the app no outbound port but the broker's", x: 420, y: 60, w: 220, h: 125 },
    { kind: "external", name: "Internet hosts", type: "External System", desc: "Only those a declared pattern covers", x: 800, y: 300, w: 210, h: 125 },
  ],
  edges: [
    { pts: [[150, 185], [150, 298]], label: "CONNECT host:port\n[HTTP proxy]", at: [150, 242] },
    { pts: [[260, 122], [418, 122]], dashed: true, label: "every other\nport refused", at: [339, 122] },
    { pts: [[260, 362], [418, 362]], label: "allowed only\n[vsock 1026]", at: [339, 362] },
    { pts: [[640, 362], [798, 362]], label: "dials, checks\nagain [TCP]", at: [719, 362] },
    { pts: [[150, 435], [150, 520], [905, 520], [905, 427]], label: "in a container: dials directly [TCP]", at: [530, 520] },
  ],
  legendKinds: [["container", "Container"], ["external", "External"]],
};
