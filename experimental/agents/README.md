# @berthos/agents

An agent framework built on Berth. It boots a sandbox (a `Computer`) loaded with resident apps, turns their exports into tools, and runs single agents or multi-agent crews against any LLM provider.

Experimental and frozen: bug and security fixes only. It isn't published to npm; releases ship the sandbox only. Use it from a clone of the [Berth repo](https://github.com/Ash20pk/BerthOS), where it is a workspace package:

```json
{ "dependencies": { "@berthos/agents": "workspace:*" } }
```

```ts
import { runAgent } from "@berthos/agents";

const result = await runAgent({
  apps: "apps/filesystem",
  task: "write a file called hello.txt with the text 'hi', then read it back",
});
```

## Docs

- [Building with `@berthos/agents`](https://github.com/Ash20pk/BerthOS/blob/main/docs/berth-agents-guide.md): the guide
- [Agents reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/agents-reference.md): the full API
- [Examples](./examples/README.md)
- [Why it's frozen](https://github.com/Ash20pk/BerthOS/blob/main/CONTRIBUTING.md#the-agents-packages-are-frozen)
