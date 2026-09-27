# @berthos/sdk

Build a resident app: a tool that runs inside a Berth sandbox and exposes functions an agent can call. The SDK gives you `defineApp()`, lifecycle hooks and clients for the context bus and semantic filesystem.

[Berth](https://github.com/Ash20pk/BerthOS) runs an AI agent's tools in a sandbox. Each tool declares what it may touch in a `berth.yml` manifest, and the Linux kernel enforces it.

```sh
npm install @berthos/sdk zod
```

## Usage

```ts
// src/index.ts
import { defineApp } from "@berthos/sdk";
import { z } from "zod";

export default defineApp((app) => {
  app.export({
    name: "ping",
    output: z.object({ message: z.string() }),
    handler: () => ({ message: "pong" }),
  });
});
```

```yaml
# berth.yml
name: hello-world
version: 0.1.0
capabilities: []
exports:
  - name: ping
    output: { message: string }
```

Declare each export in `berth.yml` too; `berth test` checks that they match. What the app can touch comes from the manifest's `capabilities`, not from the code. The fastest start is `berth init` from [`@berthos/cli`](https://www.npmjs.com/package/@berthos/cli).

Also exported: `defineConnectorApp()` (an app built from a declarative REST API description), `requestCapability()`, `configureEgressProxy()`, and the in-process `createLocalContextBus()` and `createLocalSemanticFs()` for tests.

## Docs

[SDK reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/sdk-reference.md) · [Resident apps](https://github.com/Ash20pk/BerthOS/blob/main/docs/resident-apps.md) · [Manifest reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/manifest-reference.md) · [Repo](https://github.com/Ash20pk/BerthOS)
