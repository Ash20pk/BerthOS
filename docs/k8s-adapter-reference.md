# Kubernetes Adapter Reference

`@berth/adapter-k8s` implements the same `DeployAdapter` interface as `adapter-e2b`/`adapter-daytona` (`packages/adapters/adapter-core/src/index.ts`), targeting a Kubernetes cluster instead of a managed sandbox provider. Select it via `--fleet=k8s`, or a `~/.berthrc` alias with `"adapter": "k8s"`.

## Why the PRD lists K8s but this wasn't built alongside E2B/Daytona

The PRD's Section 4.1 stack table lists `K8s` as one of four infra backends, and Section 6/8.1 reference self-hosted Kubernetes for enterprise deployments — but Section 7's actual 5 build phases only ever commit to "Deploy to E2B / Daytona via adapters" (Phase 1). A K8s adapter has no phase, milestone, or owner in the PRD text itself; it's architecture-table/vision/GTM language, not a scheduled build item. This adapter closes that specific gap as a standalone addition.

## How it maps to `DeployAdapter`

- **`upload()`** is a documented no-op, returning `target.imageRef` unchanged. Kubernetes has no platform-owned image registry the way E2B/Daytona do — this assumes the image is already resolvable by the cluster (pushed to a registry it can pull from in production, or loaded directly into a node via `kind load docker-image` for local dev/test, as this adapter's own milestone test does). A real registry-push step is a separate, larger addition, out of scope here.
- **`start()`** creates a real `Pod` (`CoreV1Api.createNamespacedPod`) via `metadata.generateName` (letting Kubernetes assign a unique name rather than inventing an id-generation scheme), labeled `app.kubernetes.io/managed-by: berth` and `berth.dev/app-name: <name>` — the label `list()` filters by.
- **`teardown()`**/**`DeployHandle.stop()`** calls `CoreV1Api.deleteNamespacedPod`.
- **`list()`** calls `CoreV1Api.listNamespacedPod` with that label selector, wrapping each result the same way `start()` does.
- **`streamLogs()`** uses the dedicated `Log` class (`@kubernetes/client-node`'s purpose-built log-follow API, not the generic `readNamespacedPodLog` REST call, which buffers a full response body rather than streaming) — it writes into a `PassThrough` stream, which is consumed as an `AsyncIterable` directly.
- **`status()`** maps `pod.status.phase` (`Pending`→`starting`, `Running`→`running`, `Succeeded`/`Failed`→`stopped`/`error`).

## A real, named rough edge: FUSE in a Pod

Every Berth image runs `semantic-fs-daemon`, which mounts FUSE at `/context` — `docker-orchestrator`'s own container start already requests `--device /dev/fuse --cap-add SYS_ADMIN` for this. A Pod spec has no `Devices` field; the closest equivalent (what this adapter does) is a `hostPath` volume for `/dev/fuse` plus an explicit `SYS_ADMIN` capability grant on the container's `securityContext`. This is **not guaranteed to work under every cluster's Pod Security Admission policy** — `SYS_ADMIN` is a broad capability, and a cluster enforcing the "restricted" PSA level will reject it outright. This is named here deliberately rather than silently reached for `privileged: true` as an unexamined workaround. A cluster that needs to run Berth Pods under a stricter PSA level would need either a Pod Security Admission exemption for Berth's namespace, or a rework of semantic-fs-daemon's FUSE requirement — both out of scope for this adapter.

## Verification

Unlike `adapter-e2b`/`adapter-daytona` — which ship with **zero tests today, mocked or real**, since exercising them needs a live paid account — this adapter gets a genuine local integration test via `kind` (Kubernetes-in-Docker), which needs no cloud account at all: `packages/adapters/adapter-k8s/test/k8s-adapter-milestone.mjs` provisions a throwaway `kind` cluster, builds and loads a real Berth production image, and exercises the full lifecycle (`upload` → `start` → `status` reaching `running` → `list` → `streamLogs` carrying real container output → `teardown` actually deleting the Pod) against the live cluster's real API — wired into CI via `.github/workflows/k8s-adapter-milestone.yml`.

## What's deliberately out of scope

- Real registry-push authentication for `upload()` (ECR/GCR/Docker Hub, etc.) — today's no-op assumes the image is already reachable.
- Anything beyond a single-container Pod per instance — no Deployments/StatefulSets, no readiness/liveness probes, no resource requests/limits.
- Namespace provisioning, RBAC, or PSA-policy configuration — this adapter assumes a namespace and appropriate permissions already exist (`BERTH_K8S_NAMESPACE`, default `default`).
