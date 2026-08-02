import { randomUUID } from "node:crypto";
import type { DeployAdapter, DeployHandle, DeployStatus, DeployTarget } from "@berth/adapter-core";

/**
 * `@kubernetes/client-node` is an optional peer dependency, mirroring
 * adapter-e2b/adapter-daytona: `berth deploy --fleet=k8s` only needs it
 * installed if you actually deploy to a Kubernetes cluster.
 */
async function loadK8s(): Promise<any> {
  try {
    return await import("@kubernetes/client-node");
  } catch {
    throw new Error(
      '@berth/adapter-k8s requires the "@kubernetes/client-node" package. Install it with `pnpm add @kubernetes/client-node` to deploy to Kubernetes.',
    );
  }
}

const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
const MANAGED_BY_VALUE = "berth";
const LABEL_SELECTOR = `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`;
/**
 * A per-instance label, distinct from "berth.dev/app-name" — that one is
 * shared by every instance of the same app (relevant once --count starts
 * more than one), so it can't be what a preview Service selects on. This one
 * is unique per start() call, generated before the Pod exists (so it can be
 * set as a label at creation time — no separate patch call needed) and
 * reused as the Service's own selector when previewUrl() is called.
 */
const INSTANCE_LABEL = "berth.dev/instance";

function namespace(): string {
  return process.env.BERTH_K8S_NAMESPACE ?? "default";
}

/**
 * Every Berth image runs semantic-fs-daemon, which needs to mount FUSE at
 * /context — the container-level equivalent of docker-orchestrator's own
 * `--device /dev/fuse --cap-add SYS_ADMIN`. Pod specs have no `Devices`
 * field; the closest equivalent is a hostPath volume for /dev/fuse plus an
 * explicit SYS_ADMIN capability grant, and it is NOT guaranteed to work
 * under every cluster's Pod Security Admission policy (SYS_ADMIN is broad,
 * and some clusters' "restricted" PSA level forbids it outright) — this is
 * a real, named rough edge, not silently worked around with
 * `privileged: true`.
 */
function podSpecFor(name: string, image: string, instanceId: string, env?: Record<string, string>): Record<string, unknown> {
  return {
    metadata: {
      generateName: `${name}-`,
      labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, "berth.dev/app-name": name, [INSTANCE_LABEL]: instanceId },
    },
    spec: {
      restartPolicy: "Never",
      containers: [
        {
          name,
          image,
          env: Object.entries(env ?? {}).map(([envName, value]) => ({ name: envName, value })),
          securityContext: { capabilities: { add: ["SYS_ADMIN"] } },
          volumeMounts: [{ name: "dev-fuse", mountPath: "/dev/fuse" }],
        },
      ],
      volumes: [{ name: "dev-fuse", hostPath: { path: "/dev/fuse", type: "CharDevice" } }],
    },
  };
}

function statusFromPhase(phase: string | undefined): DeployStatus {
  switch (phase) {
    case "Pending":
      return "starting";
    case "Running":
      return "running";
    case "Succeeded":
      return "stopped";
    case "Failed":
      return "error";
    default:
      return "starting";
  }
}

class K8sDeployHandle implements DeployHandle {
  constructor(
    public id: string,
    /** The Pod's own container name — distinct from `id` (the Pod's name, which carries a generateName suffix). Needed by the Log API, which addresses a specific container within a Pod. */
    private containerName: string,
    private coreApi: any,
    private logClient: any,
    /** This instance's INSTANCE_LABEL value — the Service selector previewUrl() creates targets exactly this Pod, not every Pod sharing this app's name. */
    public readonly instanceId: string,
  ) {}

  async status(): Promise<DeployStatus> {
    const pod = await this.coreApi.readNamespacedPod({ name: this.id, namespace: namespace() });
    return statusFromPhase(pod.status?.phase);
  }

  async *streamLogs(): AsyncIterable<string> {
    const { PassThrough } = await import("node:stream");
    const stream = new PassThrough();
    const abortController = await this.logClient.log(namespace(), this.id, this.containerName, stream, { follow: true });
    try {
      for await (const chunk of stream) {
        yield chunk.toString("utf-8");
      }
    } finally {
      abortController.abort();
    }
  }

  async stop(): Promise<void> {
    await this.coreApi.deleteNamespacedPod({ name: this.id, namespace: namespace() });
  }
}

export function createK8sAdapter(): DeployAdapter {
  return {
    name: "k8s",

    // Kubernetes has no platform-owned image registry the way E2B/Daytona
    // do — a documented no-op, on the explicit assumption the image is
    // already resolvable by the cluster (pushed to a registry it can pull
    // from, or, for local dev/test, loaded directly into the node via
    // `kind load docker-image`). Real registry-push auth is a separate,
    // larger fix and out of scope here.
    async upload(target: DeployTarget) {
      return { remoteImageRef: target.imageRef };
    },

    async start(remoteImageRef: string, target: DeployTarget) {
      const k8s = await loadK8s();
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);
      const logClient = new k8s.Log(kc);

      // Generated before the Pod exists so it can be a label at creation
      // time (one API call) rather than a label patched on afterward.
      const instanceId = randomUUID().replace(/-/g, "");
      const pod = await coreApi.createNamespacedPod({
        namespace: namespace(),
        body: podSpecFor(target.manifest.name, remoteImageRef, instanceId, target.env),
      });

      return new K8sDeployHandle(pod.metadata!.name!, target.manifest.name, coreApi, logClient, instanceId);
    },

    async teardown(handle: DeployHandle) {
      await handle.stop();
    },

    async list() {
      const k8s = await loadK8s();
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);
      const logClient = new k8s.Log(kc);

      const podList = await coreApi.listNamespacedPod({ namespace: namespace(), labelSelector: LABEL_SELECTOR });
      return podList.items.map(
        (pod: any) =>
          new K8sDeployHandle(
            pod.metadata.name,
            pod.spec.containers[0].name,
            coreApi,
            logClient,
            pod.metadata.labels?.[INSTANCE_LABEL] ?? "",
          ),
      );
    },

    // Creates a ClusterIP Service selecting this exact Pod (via its
    // INSTANCE_LABEL, not the app-wide name label, so this targets one
    // instance even when --count started several). Reports the in-cluster
    // DNS name, not a public URL — a real public URL needs the cluster's own
    // Ingress/LoadBalancer setup, same honesty as upload()'s no-op above.
    // Only ever called when the app opted in via berth.yml's expose.preview.
    async previewUrl(handle: DeployHandle, port: number) {
      if (!(handle instanceof K8sDeployHandle) || !handle.instanceId) return null;
      const k8s = await loadK8s();
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);

      const serviceName = `berth-preview-${handle.instanceId.slice(0, 12)}-${port}`;
      const ns = namespace();
      try {
        await coreApi.createNamespacedService({
          namespace: ns,
          body: {
            metadata: { name: serviceName },
            spec: {
              selector: { [INSTANCE_LABEL]: handle.instanceId },
              ports: [{ port, targetPort: port }],
              type: "ClusterIP",
            },
          },
        });
      } catch (err: any) {
        // Already created by an earlier previewUrl() call for this same
        // instance/port — fine, the Service is already there and correct.
        if (err?.body?.reason !== "AlreadyExists" && err?.code !== 409) return null;
      }

      return `${serviceName}.${ns}.svc.cluster.local:${port}`;
    },
  };
}
