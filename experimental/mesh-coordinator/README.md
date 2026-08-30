# @berth/mesh-coordinator

Coordination service for Berth's WireGuard mesh: allocates stable mesh IPs, exchanges public keys, and mutually-matches peers before introducing them (see docs/mesh-reference.md).

Part of [Berth](https://github.com/Ash20pk/BerthOS) — IAM for agents — declared capabilities, kernel-enforced, audit-trailed. The `berth.yml` capability line is the boundary; Landlock + seccomp hold it.

```sh
npm install @berth/mesh-coordinator
```

## Documentation

- [Mesh reference](https://github.com/Ash20pk/BerthOS/blob/main/docs/mesh-reference.md)
- Repo: https://github.com/Ash20pk/BerthOS
