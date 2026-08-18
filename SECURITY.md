# Security Policy

Berth's core pitch is enforcing agent permission boundaries at the kernel level (Landlock), so vulnerabilities here matter more than in a typical early-stage repo. Please report them privately, not as a public issue.

**Read [docs/threat-model.md](./docs/threat-model.md) first.** It states the adversaries Berth is designed against, which trust boundary each mechanism holds, and — at equal length — what is *not* protected today. A bypass of anything it lists in the kernel or broker tier is a vulnerability. A gap it already names as unenforced is expected, though a worse-than-documented version of one is still worth reporting.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/Ash20pk/BerthOS/security/advisories/new) for this repo. If that's not available to you, open a private message to [@Ash20pk](https://github.com/Ash20pk) instead of a public issue.

Include what you can:
- The capability or component involved (e.g. `agent-init`/Landlock, the egress broker, the grants server)
- Whether it's a bypass of an *enforced* boundary versus a gap in something the docs already mark as unenforced (see the [threat model](./docs/threat-model.md#not-protected-against-today) and [the capability table](./docs/kernel-enforcement.md#available-capabilities) — several capabilities are explicitly recorded-only today, not kernel- or broker-enforced, and that's expected, not a vulnerability)
- Reproduction steps, ideally against a real Linux host or CI (`ubuntu-latest`) rather than Docker Desktop for Mac, where Landlock isn't active — see [docs/capability-tokens-reference.md](./docs/capability-tokens-reference.md)

## Response time

This is a solo-maintained project. I'll do my best to respond quickly to security reports specifically — faster than the general PR/issue queue — but there's no formal SLA yet.
