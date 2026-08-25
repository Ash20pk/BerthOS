# Examples

Each of these is a runnable proof of one Berth claim. They fall in two groups:
the **capability demos** show a boundary the kernel holds even when everything
above it is compromised, and the **framework demos** show how you reach that
boundary from the agent stack you already use.

The capability demos are written to be honest about their own result: on a host
where the kernel doesn't actually enforce (Docker Desktop for Mac), they refuse
to print a denial they can't attribute to the kernel, and exit non-zero. Run
[`berth doctor`](../docs/doctor-reference.md) to see which host you're on;
[docs/mac-enforcement.md](../docs/mac-enforcement.md) is a four-flag Colima
recipe that turns a Mac into an enforcing host with no kernel build.

## Capability demos — watch the kernel say no

| Demo | What it proves | Needs a kernel? | Needs an API key? |
|------|----------------|:---------------:|:-----------------:|
| [`kernel-says-no`](./kernel-says-no) | The manifest line is the boundary: a write outside `filesystem:write:/workspace` dies in `open(2)`. No model, no agent — just the boundary. | yes | no |
| [`prompt-injection`](./prompt-injection) | A **fully compromised model** obeys an injected instruction to persist a backdoor in `/etc`; the kernel refuses anyway, and the attempt lands in a tamper-evident audit trail. The real `@berth/agents` loop, a scripted jailbroken LLM. | yes | no |
| [`no-egress`](./no-egress) | The code-interpreter runs attacker-chosen code to completion, and every outbound path — TCP (Landlock), DNS/UDP (seccomp), `curl` — is refused because `berth.yml` declared no network. Egress is a capability, not a default. | yes | no |
| [`audit-trail`](./audit-trail) | The hash-chained audit record catches a single-record edit at the exact record — and then demonstrates its own limit (a full rewrite re-verifies). Tamper-evident, not tamper-proof, proven both ways. | no | no |

None of the capability demos needs an API key: the point is the boundary, and a
real model only ever reaches the same tool call the scripted one does. The
interesting part is what happens *after* the call.

## Framework demos — reach it from your stack

| Demo | What it shows |
|------|---------------|
| [`agents/simple-agent`](./agents/simple-agent) | `runAgent({ apps, task })` — boot a Computer from a resident app, run one task, clean up. Auto-detects `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`. |
| [`agents/agent-server`](./agents/agent-server) | An `Agent` behind an HTTP server (`POST /task`, `POST /chat`). |
| [`agents/with-vercel-ai-sdk`](./agents/with-vercel-ai-sdk) | A booted Computer's tools handed to the Vercel AI SDK's `generateText` — Berth's sandbox with no `@berth/agents` `Agent` anywhere in it. |
| [`resident-apps`](./resident-apps) | Writing the resident apps the demos above run on: `hello-world`, `http-fetch`, `generic-connector`. |

## Running any of them

```bash
pnpm install && pnpm build     # from the repo root, once — @berth/* is not on npm yet
cd examples/<name>
pnpm start                     # docker build chatter goes to stderr; add 2>/dev/null for just the demo
```

The first run of a capability demo builds the app's OS image and is slow;
later runs reuse it. The framework demos that need a model skip cleanly (they
don't fail) when no API key is set.
