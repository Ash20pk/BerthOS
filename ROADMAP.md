# Roadmap

Berth's goal is simple to state: any agent, on any framework, should be able to run its tools behind permissions the kernel enforces, and prove afterwards that it did. This page is what works today, what we're building next, and where you can help.

Want to take something on? Open an issue saying which item, or comment on the one that exists, before you start. [CONTRIBUTING.md](./CONTRIBUTING.md) covers setup and how PRs land.

## Available today

| Area | What you get | Docs |
|---|---|---|
| **Kernel-enforced sandbox** | A `berth.yml` capability list compiled into a Landlock and seccomp policy, applied before the tool's first line runs. Files, outbound network, raw sockets and namespaces are denied unless declared, and every app runs as its own uid. | [Enforcement](./docs/kernel-enforcement.md) |
| **Works with your agent** | An MCP server for Claude Code, Claude Desktop, Cursor or any MCP client, plus tool adapters for the Vercel AI SDK and LangChain. | [MCP quickstart](./docs/mcp-quickstart.md) |
| **Resident apps** | Build a tool as a manifest plus a handler, in TypeScript or Python. First-party apps: filesystem, shell, browser, code interpreter, GitHub, notes. | [Resident apps](./docs/resident-apps.md) |
| **Scoped network access** | An egress proxy that scopes browsing by hostname, and a GitHub proxy that scopes API calls by method and path. | [Egress](./docs/egress-broker-reference.md) · [GitHub](./docs/github-api-scoping-reference.md) |
| **Evidence** | `berth doctor` checks whether a host can enforce anything, a hash-chained audit trail records what happened, and `berth attest` produces a per-run record of the enforcement that was measured. | [Doctor](./docs/doctor-reference.md) · [Audit](./docs/audit-reference.md) · [Attestation](./docs/attestation-reference.md) |
| **Apps that share state** | Several apps in one sandbox, a pub/sub context bus between them, a filesystem searchable by why each file exists, and snapshot and restore. | [Berth OS](./docs/berth-os-reference.md) |
| **Run it anywhere** | Local Docker, or deploy the same sandbox to E2B, Daytona or Kubernetes. | [Quickstart](./docs/quickstart.md) · [Kubernetes](./docs/k8s-adapter-reference.md) |
| **Open specs** | The manifest format and the attestation record as standalone, versioned specs, each with a conformance suite. | [Manifest](./spec/capability-manifest) · [Attestation](./spec/attestation-record) |

## Now

What's being worked on first.

- **First npm and PyPI release.** Publish `@berthos/*`, `berthos-sdk` and `berthos-agents`, so `npm install -g @berthos/cli` is the way in, not a clone.
- **A standalone sandbox package.** `Computer` and the framework adapters (`toAiSdkTools`, `toLangChainTools`, `toToolSpecs`) move out of the agent framework into their own package, so embedding Berth in an existing TypeScript agent doesn't mean installing a framework.
- **A smoother first run on macOS.** Get from `berth doctor --fix` to a real kernel denial in one step, with no Docker setup to understand first.

## Next

Planned, and open to contributors now.

- **MCP bridge authentication.** Let `berth mcp` verify who is calling, not just which tools they can reach. *Help wanted.*
- **One MCP bridge for several apps.** Serve a whole multi-app sandbox from a single `berth mcp`, instead of one bridge per app. *Help wanted.*
- **Per-app network proxies.** Give each app in a shared sandbox its own egress allowlist, rather than one per sandbox.
- **More API proxies.** The GitHub proxy's method-and-path scoping, generalised to other APIs (Slack, Linear, Stripe), so an app can be scoped to specific API calls, not just a hostname. *Help wanted.*
- **Signed attestations.** Sign attestation records and publish their hashes somewhere append-only, so a record proves who produced it, not just that it wasn't edited.
- **Reconnect to remote sandboxes.** `berth os up` keeps a local sandbox alive and reconnects in milliseconds. Bring the same to sandboxes deployed on E2B, Daytona and Kubernetes.

## Later

Direction, not yet scheduled. Design discussion welcome in issues.

- **A public app registry.** Publish and install resident apps from a hosted registry, instead of one you run yourself.
- **Least privilege for the mesh daemon.** Run the WireGuard daemon without root, and identify callers on its control socket from the kernel rather than from the request.
- **A sandboxed browser inside the sandbox.** Re-enable Chromium's own sandbox inside Berth's, so a renderer exploit is contained twice.
- **Content search.** Search `/context` by file contents, not only by the tags an app attached.
- **Encryption at rest and team identity.** Encrypted agent state and snapshots, and users and roles for the registry and mesh coordinator.

## Build a resident app

The quickest way to make Berth more useful. Each of these is self-contained, needs no changes to Berth itself, and makes a good first contribution:

| App | Scope it should declare |
|---|---|
| **Slack** | Post messages and read history in specific channels |
| **Postgres / SQL** | Query and change specific tables |
| **Email** | Read, send and search within specific labels or folders |
| **Linear / Jira** | Read and create issues, like [`github-assistant`](./apps/github-assistant) |
| **Stripe** | Read-only reporting first |
| **Calendar** | Read availability, create events |
| **Playwright QA** | Run a test suite against a site, building on [`browser-native`](./apps/browser-native) |

Start from `berth init my-app`, read [Resident apps](./docs/resident-apps.md), and open a [resident app proposal](./.github/ISSUE_TEMPLATE/resident_app_proposal.md) if you'd like feedback on the scope before writing code.
