# @berthos/adapter-core

The `DeployAdapter` interface that every Berth deploy target implements. `@berthos/adapter-e2b`, `@berthos/adapter-daytona` and `@berthos/adapter-k8s` build on it, and the `berth` CLI talks only to this interface, never to a provider SDK.

[Berth](https://github.com/Ash20pk/BerthOS) runs an AI agent's tools in a sandbox. Each tool declares what it may touch in a `berth.yml` manifest, and the Linux kernel enforces it.

```sh
npm install @berthos/adapter-core
```

You need this package only to write an adapter for a new provider.

## Usage

```ts
import type { DeployAdapter } from "@berthos/adapter-core";

export function createMyAdapter(): DeployAdapter {
  return {
    name: "my-provider",
    upload: async (target) => pushImage(target.imageRef),        // -> { remoteImageRef }
    start: async (remoteImageRef, target) => bootInstance(remoteImageRef, target), // -> DeployHandle
    teardown: async (handle) => handle.stop(),
  };
}
```

| Member | What it does |
|---|---|
| `upload(target)` | Make `target.imageRef` available to the provider; returns `{ remoteImageRef }` |
| `start(remoteImageRef, target)` | Boot an instance; returns a `DeployHandle` (`id`, `status()`, `streamLogs()`, `stop()`) |
| `teardown(handle)` | Stop and remove an instance |
| `list?`, `connect?`, `previewUrl?`, `rpcUrl?`, `pause?`, `resume?`, `fork?`, `snapshot?` | Optional. Implement the ones your provider supports; the CLI falls back or reports the feature as unsupported otherwise |

`DeployTarget` is `{ imageRef, manifest, env?, region? }`. `withTimeout()`, `DEPLOY_CREATE_TIMEOUT_MS` (5 min) and `DEPLOY_READ_TIMEOUT_MS` (30 s) are exported for bounding provider calls.

## Docs

[Kubernetes adapter reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/k8s-adapter-reference.md) (a worked example of the interface) · [Repo](https://github.com/Ash20pk/BerthOS)
