# Examples

Each example is a runnable proof of one Berth claim. The **capability demos** show a boundary the kernel holds even when everything above it is compromised. The **framework demos** show how to reach that boundary from the agent stack you already use.

## Run any of them

```bash
pnpm install && pnpm build     # once, from the repo root
cd examples/<name>
pnpm start                     # Docker build output goes to stderr; add 2>/dev/null to see only the demo
```

The first run builds the app's image and is slow. Later runs reuse it. The examples use the experimental agent framework (`@berthos/agents`), which isn't published, so they run from a clone.

## Capability demos: watch the kernel say no

| Demo | What it proves | Needs an enforcing kernel | Needs an API key |
|---|---|:---:|:---:|
| [`kernel-says-no`](./kernel-says-no) | A write outside `filesystem:write:/workspace` fails in `open(2)`. No model, no agent. | yes | no |
| [`prompt-injection`](./prompt-injection) | A fully compromised model obeys an injected instruction to plant a backdoor in `/etc`. The kernel refuses, and the attempt lands in the audit trail. | yes | no |
| [`no-egress`](./no-egress) | The code interpreter runs attacker-chosen code, and every outbound path (TCP, DNS over UDP, `curl`) is refused because `berth.yml` declares no network. | yes | no |
| [`audit-trail`](./audit-trail) | The hash-chained audit trail catches a single edited record, and a full rewrite still verifies: tamper-evident, not tamper-proof. | no | no |

None of these needs an API key. A scripted model reaches the same tool call a real one would, and the point is what happens after the call.

**They need a kernel with Landlock** (Linux 6.7+). Run [`berth doctor`](../docs/doctor-reference.md) to check your machine. Docker Desktop on macOS or Windows can't enforce, so the demos refuse to boot there. With `BERTH_ALLOW_UNENFORCED=1` they boot anyway, report `NOT ENFORCED` and exit 1 instead of printing a denial the kernel didn't make. On a Mac, [Colima](../docs/mac-enforcement.md) gives you a VM that enforces (`berth doctor --fix` sets it up).

## Framework demos: reach it from your stack

| Demo | What it shows | Needs an API key |
|---|---|:---:|
| [`agents/simple-agent`](./agents/simple-agent) | `runAgent({ apps, task })`: boot a Computer from a resident app, run one task, clean up. | yes |
| [`agents/agent-server`](./agents/agent-server) | An agent served over HTTP (`GET /health`, `POST /task`, `POST /chat`). | yes |
| [`agents/with-vercel-ai-sdk`](./agents/with-vercel-ai-sdk) | A Computer's tools handed to the Vercel AI SDK's `generateText`, with no Berth `Agent` involved. | yes (`OPENAI_API_KEY`) |
| [`resident-apps`](./resident-apps) | The resident apps the demos run on: `hello-world`, `http-fetch`, `generic-connector`. | no |

`simple-agent` and `agent-server` use `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, whichever is set, and print `SKIP` and exit cleanly when neither is. Like the capability demos, they refuse to boot on a kernel that can't enforce unless you set `BERTH_ALLOW_UNENFORCED=1`.
