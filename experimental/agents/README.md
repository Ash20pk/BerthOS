# @berthos/agents

computer -> agent -> tool: boots a Berth computer loaded with resident apps, generates a tool list from their exports, and wires any LLM provider into single- or multi-agent crews.

Part of [Berth](https://github.com/Ash20pk/BerthOS) — IAM for agents — declared capabilities, kernel-enforced, audit-trailed. The `berth.yml` capability line is the boundary; Landlock + seccomp hold it.

Not published to npm: this package is experimental, and releases ship the sandbox only. Use it from a clone of the repository, where it is a workspace package (`"@berthos/agents": "workspace:*"`).

> **Frozen surface.** This package is a *reference consumer* of the Berth
> substrate, not a competing agent framework. Its API is frozen: bug and
> security fixes only — no new Crew shapes, providers, or parity features.
> See [CONTRIBUTING.md — "The agents packages are frozen"](https://github.com/Ash20pk/BerthOS/blob/main/CONTRIBUTING.md#the-agents-packages-are-frozen)
> for the canonical statement and the supported integration seams.

## Documentation

- [Agents reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/agents-reference.md)
- Repo: https://github.com/Ash20pk/BerthOS
