export default {
  name: "github-api-scoping-reference",
  w: 800,
  h: 790,
  title: "GitHub API proxy: containers (C4 level 2)",
  boundaries: [
    { x: 20, y: 30, w: 580, h: 440, label: "Sandbox" },
    { x: 20, y: 540, w: 300, h: 180, label: "Host", sub: "microVM only" },
  ],
  boxes: [
    { kind: "container", name: "Resident app", type: "Container: Node.js", desc: "Declares github:read / github:write scopes and network:connect:8092; trusts the proxy's CA", x: 40, y: 60, w: 540, h: 125 },
    { kind: "container", name: "GitHub API proxy", type: "Container: Node.js, 127.0.0.1:8092", desc: "Ends TLS, maps method and path to a scope", x: 40, y: 300, w: 240, h: 125 },
    { kind: "container", name: "Egress broker", type: "Container: Node.js, 127.0.0.1:8090", desc: "Refuses api.github.com when a github:* scope is declared", x: 340, y: 300, w: 240, h: 125 },
    { kind: "container", name: "Host dialer", type: "Container: in berth-vmm", desc: "Its own allowlist, with api.github.com:443 added", x: 40, y: 560, w: 260, h: 115 },
    { kind: "external", name: "api.github.com", type: "External System", desc: "Only requests a declared scope covers", x: 520, y: 560, w: 240, h: 115 },
  ],
  edges: [
    { pts: [[160, 185], [160, 298]], label: "CONNECT api.github.com\n[HTTP proxy]", at: [160, 242] },
    { pts: [[460, 185], [460, 298]], dashed: true, label: "api.github.com\nrefused", at: [460, 242] },
    { pts: [[160, 425], [160, 558]], label: "relay, then\n[vsock 1026]", at: [160, 505] },
    { pts: [[300, 617], [518, 617]], label: "checks, dials\n[TCP]", at: [409, 617] },
    { pts: [[260, 425], [260, 500], [640, 500], [640, 558]], label: "in a container: dials directly [TLS]", at: [450, 500] },
  ],
  legendKinds: [["container", "Container"], ["external", "External"]],
};
