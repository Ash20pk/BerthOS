# @berth/sdk

Resident app SDK: defineApp(), lifecycle hooks, context bus client — runs inside the sandbox.

Part of [Berth](https://github.com/Ash20pk/BerthOS) — IAM for agents — declared capabilities, kernel-enforced, audit-trailed. The `berth.yml` capability line is the boundary; Landlock + seccomp hold it.

```sh
npm install @berth/sdk
```

## Usage

```ts
import { defineApp } from "@berth/sdk";

export default defineApp((app) => {
  // runs inside the sandbox; capabilities come from berth.yml
  app.export({
    name: "ping",
    handler: () => ({ message: "pong" }),
  });
});
```

## Documentation

- [SDK reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/sdk-reference.md)
- Repo: https://github.com/Ash20pk/BerthOS
