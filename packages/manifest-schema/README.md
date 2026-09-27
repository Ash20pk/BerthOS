# @berthos/manifest-schema

Load, validate and parse `berth.yml`, the manifest that declares a resident app's capabilities and exports.

[Berth](https://github.com/Ash20pk/BerthOS) runs an AI agent's tools in a sandbox. Each tool declares what it may touch in a `berth.yml` manifest, and the Linux kernel enforces it.

```sh
npm install @berthos/manifest-schema
```

## Usage

```ts
import { loadManifest, parseCapability, ManifestValidationError } from "@berthos/manifest-schema";

try {
  const manifest = await loadManifest("berth.yml");
  for (const cap of manifest.capabilities) {
    console.log(parseCapability(cap)); // { namespace: "filesystem", action: "write", scope: "/workspace" }
  }
} catch (err) {
  if (err instanceof ManifestValidationError) console.error(err.message);
  else throw err;
}
```

`validateManifest(obj)` does the same for an object you already parsed, and `BerthManifestSchema` is the underlying Zod schema.

## Docs

[Manifest reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/manifest-reference.md) · [Capability manifest spec](https://github.com/Ash20pk/BerthOS/tree/main/spec/capability-manifest) · [Repo](https://github.com/Ash20pk/BerthOS)
