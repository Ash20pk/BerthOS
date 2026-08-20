# @berth/agents

computer -> agent -> tool: boots a Berth computer loaded with resident apps, generates a tool list from their exports, and wires any LLM provider into single- or multi-agent crews.

Part of [Berth](https://github.com/Ash20pk/BerthOS) — capability-scoped, kernel-enforced sandboxes for AI agents. The `berth.yml` capability line is the boundary; Landlock + seccomp hold it.

```sh
npm install @berth/agents
```

> **Frozen surface.** The agents package is a reference consumer of the Berth
> substrate, not a competing agent framework — its API shape is frozen.
> Build on the substrate (SDK, manifest, orchestrator) directly.

## Documentation

- [Agents reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/agents-reference.md)
- Repo: https://github.com/Ash20pk/BerthOS
