# Threat model

Berth's promise is that what an agent's tools can touch is decided by the Linux kernel, not by the model behaving itself. A promise like that only means something when you say who it holds against. This page does: what Berth protects, from whom, how, and what it assumes you trust.

## What Berth protects

- **Your machine.** Tools run in a container. In local development your project folder is mounted read-only, so a tool can't plant a git hook or rewrite your code.
- **Your credentials.** API keys reach the sandbox through a private file, not environment variables, so they don't show up in `docker inspect` or in snapshots. A secret an app declares is visible to that app only.
- **Your network.** A tool can't make outbound connections unless its manifest allows them, and it can't reach cloud metadata endpoints, your local network or the Docker host even when browsing is allowed.
- **The line between tools.** Several apps can share one sandbox without borrowing each other's permissions. Each app runs as its own user, with its own rules.
- **The rules themselves.** An app can't edit its own manifest or the policy compiled from it to grant itself more.

## Who it protects against

**A tricked agent.** This is what Berth is built for. A model reads attacker-controlled text (a web page, a file, a tool result) and starts making tool calls for the attacker. It can call any tool it has, with any arguments, as often as it likes. Berth's answer: whatever the calls, a tool can only touch what its manifest declares. Everything else is refused by the kernel before the tool's code sees it.

**Attacker code running inside the sandbox.** An agent with a code interpreter or a shell can be tricked into running arbitrary code. That code gets one app's user, that app's kernel rules, and nothing else. It can't mount filesystems, create namespaces to regain privileges, open raw sockets, read another app's declared secrets or signal another app's processes.

**Someone on your network.** Every port `berth dev` opens for watching a browser or terminal binds to `127.0.0.1` only and needs a password generated fresh on each boot.

**Other users on the same machine.** Files that hold credentials are readable by you alone.

**A malicious website.** Browsing goes through a proxy that only allows the hostnames the app declared.

## How it's enforced

Three layers, from strongest to softest. Where a capability is enforced is the real security claim, not its name.

| Layer | What it is | What it covers |
|---|---|---|
| **Kernel** | Landlock and seccomp rules, applied before the app starts and impossible to undo from inside | File reads and writes, outbound TCP by port, UDP and raw sockets, namespace creation, and privileges dropped for every app |
| **Proxy** | A proxy the app's traffic has to pass through | Browsing by hostname, and GitHub API calls by method and path |
| **Host** | How Berth sets up the container and the files around it | Loopback-only ports with per-boot passwords, credentials delivered by private file, read-only project mounts |

Each capability's layer is listed in [enforcement](./kernel-enforcement.md#available-capabilities). The kernel layer is the one to rely on. The proxy layer exists because the kernel sees ports, not hostnames.

### It needs a kernel that can enforce

Everything in the kernel layer depends on Landlock, which Linux has had since 5.13. Docker Desktop's VM on macOS and Windows doesn't provide it. Run `berth doctor` to see what your machine supports; on a Mac, `berth doctor --fix` sets up a VM that does.

So that local development still works on those machines, Berth **runs apps unrestricted, with a warning, when it can't enforce**. For anything that matters, set `BERTH_REQUIRE_ENFORCEMENT=1`: Berth then refuses to start an app it can't lock down. `Computer.boot()` turns this on by default.

## What Berth trusts

Every security tool draws a line somewhere. Berth assumes these are trustworthy and doesn't try to defend against them:

- **Root on the host.** Anyone who can run `docker exec` on the host can reach inside the sandbox directly and bypass every rule. This is how Docker works, not a Berth setting.
- **The host kernel, Docker and the hypervisor.** A bug that lets code escape a container is outside what Berth can stop. For that tier, Berth can run under a hardened runtime such as gVisor (`BERTH_RUNTIME`), but today that trades away the kernel layer; `berth doctor --runtime` explains the trade.
- **The code you install.** Building a resident app runs its install steps on the machine doing the build. Read a third-party app before installing it, as you would any other code.
- **Your LLM provider.** It sees every prompt and every tool result. That's inherent to using a hosted model.

What we're hardening next is on the [roadmap](../ROADMAP.md).

## Checking it yourself

- **`berth doctor`** reports whether your machine can enforce anything, by trying a write that a working kernel must refuse.
- **`berth attest <runId>`** produces a record of a run and the enforcement measured for its boot. It says `NOT_ENFORCED` when nothing was enforced, and anyone can verify it with a standalone script. See [attestation](./attestation-reference.md).
- **[The containment benchmark](../bench/README.md)** runs the same attack probe under plain Docker, Berth, and Berth with its kernel layer switched off, and compares what each one stopped.
- **[The break-out box](../breakout/README.md)** is a public sandbox that hands strangers code execution and hides two flags behind Berth's rules. It runs exactly what any app gets, with no extra hardening.

## Reporting

Found a way around the kernel or proxy layer? That's a vulnerability. Please report it privately as described in [SECURITY.md](../SECURITY.md).
