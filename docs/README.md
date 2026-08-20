# Berth documentation

Berth is a **substrate**: capability-scoped, kernel-enforced sandboxes for AI
agents. The docs split the same way the project does — the substrate itself,
and the frozen reference consumer that proves it's usable from an agent loop.

## Start here

- [Why Berth](./why-berth.md)
- [Quickstart](./quickstart.md) · [Getting started](./getting-started.md)
- [MCP quickstart](./mcp-quickstart.md) — the fastest path to a kernel denial
- [Threat model](./threat-model.md) — what is and is not protected, honestly

## The substrate

**Enforcement**
- [Kernel enforcement](./kernel-enforcement.md) (Landlock + seccomp)
- [Capability tokens](./capability-tokens-reference.md)
- [Doctor](./doctor-reference.md) — does *your* host actually enforce?
- [macOS enforcement](./mac-enforcement.md) (Colima host)
- [Per-app uid design](./per-app-uid-design.md)
- [Secrets](./secrets-reference.md) · [TLS](./tls-reference.md) · [Audit](./audit-reference.md)
- [Egress broker](./egress-broker-reference.md) · [GitHub API scoping](./github-api-scoping-reference.md)
- [Governance gate](./governance-reference.md)

**Runtime & manifest**
- [Berth OS](./berth-os.md) · [Berth OS reference](./berth-os-reference.md)
- [Manifest (`berth.yml`)](./manifest-reference.md)
- [Resident apps](./resident-apps.md) · [Multi-app](./multi-app-reference.md)
- [Context bus](./context-bus-reference.md) · [Semantic FS](./semantic-fs-reference.md)
- [Snapshots](./computer-snapshots-reference.md) · [Mesh networking](./mesh-reference.md)
- [App registry](./app-registry-reference.md)

**SDKs & seams (how agent frameworks reach the substrate)**
- [SDK (TypeScript)](./sdk-reference.md)
- [Python SDK](./sdk-python-reference.md) · [Python context bus](./sdk-python-context-bus-reference.md)
- [MCP bridge](./mcp-bridge-reference.md)
- [K8s adapter](./k8s-adapter-reference.md)

## The reference consumer (frozen)

`@berth/agents` / `berth-agents` demonstrate the substrate from an agent
loop. Their API is frozen — bug and security fixes only; see
[CONTRIBUTING.md](../CONTRIBUTING.md#the-agents-packages-are-frozen).

- [Agents reference](./agents-reference.md) · [Agents guide](./berth-agents-guide.md)
- [Python agents reference](./agents-python-reference.md)
