export default {
  name: "design-microvm-layers",
  w: 1180,
  h: 560,
  title: "microVM layers: containers (C4 level 2)",
  boundaries: [
    { x: 20, y: 30, w: 300, h: 470, label: "Host" },
    { x: 420, y: 290, w: 740, h: 210, label: "Guest", sub: "microVM" },
  ],
  boxes: [
    { kind: "container", name: "berth CLI", type: "Container: Node.js", desc: "Works out which layers the apps' manifests need", x: 40, y: 60, w: 260, h: 125 },
    { kind: "external", name: "vm-artifacts release", type: "External System", desc: "Carries layer-<name>-<sha>.erofs next to the kernel and rootfs", x: 460, y: 60, w: 260, h: 125 },
    { kind: "container", name: "berth-vmm", type: "Container: Rust + libkrun", desc: "Checks each layer against its pin and base; attaches it read-only", x: 40, y: 330, w: 260, h: 125 },
    { kind: "container", name: "berth-init", type: "Container: Rust, PID 1", desc: "Mounts each layer and lays its directories over the base (overlayfs)", x: 460, y: 330, w: 260, h: 125 },
    { kind: "container", name: "Display stack", type: "Container: Xvfb, x11vnc, websockify", desc: "Under agent-init, for an app that declares browser:*", x: 880, y: 330, w: 260, h: 125 },
  ],
  edges: [
    { pts: [[300, 122], [458, 122]], label: "downloads once,\nchecks the pin", at: [379, 122] },
    { pts: [[170, 185], [170, 328]], label: "run --layer <name>", at: [170, 257] },
    { pts: [[300, 392], [458, 392]], label: "read-only\n[virtio-blk]", at: [379, 392] },
    { pts: [[720, 392], [878, 392]], label: "starts it", at: [799, 392] },
  ],
  legendKinds: [["container", "Container"], ["external", "External"]],
};
