import { randomUUID } from "node:crypto";
import { withTimeout, DEPLOY_CREATE_TIMEOUT_MS, DEPLOY_READ_TIMEOUT_MS } from "@berth/adapter-core";
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
    const pod = await withTimeout<any>(
      this.coreApi.readNamespacedPod({ name: this.id, namespace: namespace() }),
      DEPLOY_READ_TIMEOUT_MS,
      `k8s readNamespacedPod("${this.id}")`,
    );
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
    await withTimeout<any>(
      this.coreApi.deleteNamespacedPod({ name: this.id, namespace: namespace() }),
      DEPLOY_READ_TIMEOUT_MS,
      `k8s deleteNamespacedPod("${this.id}")`,
    );
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
      // Not retried on timeout — same reasoning as the other two adapters'
      // create-ish calls: an ambiguous timeout here could mean the Pod was
      // actually created server-side, and generateName means a retry would
      // create a second one rather than safely re-attempting the same one.
      const pod = await withTimeout<any>(
        coreApi.createNamespacedPod({ namespace: namespace(), body: podSpecFor(target.manifest.name, remoteImageRef, instanceId, target.env) }),
        DEPLOY_CREATE_TIMEOUT_MS,
        `k8s createNamespacedPod("${target.manifest.name}")`,
      );

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

      const podList = await withTimeout<any>(
        coreApi.listNamespacedPod({ namespace: namespace(), labelSelector: LABEL_SELECTOR }),
        DEPLOY_READ_TIMEOUT_MS,
        "k8s listNamespacedPod()",
      );
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
        await withTimeout<any>(
          coreApi.createNamespacedService({
            namespace: ns,
            body: {
              metadata: { name: serviceName },
              spec: {
                selector: { [INSTANCE_LABEL]: handle.instanceId },
                ports: [{ port, targetPort: port }],
                type: "ClusterIP",
              },
            },
          }),
          DEPLOY_CREATE_TIMEOUT_MS,
          `k8s createNamespacedService("${serviceName}")`,
        );
      } catch (err: any) {
        // Already created by an earlier previewUrl() call for this same
        // instance/port — fine, the Service is already there and correct.
        if (err?.body?.reason !== "AlreadyExists" && err?.code !== 409) {
          // Anything else (RBAC denial, quota, a genuine timeout) is a real
          // failure, not "no preview available yet" — but the deploy itself
          // already succeeded (the Pod is running) by the time this is
          // called, and `berth deploy`'s own call site treats a null return
          // as "skip this line" rather than checking for one, so throwing
          // here would crash an otherwise-successful deploy over a
          // nice-to-have. Logged loudly instead, so it's never confused
          // with the ordinary "not ready yet" case.
          console.error(`[adapter-k8s] previewUrl: createNamespacedService("${serviceName}") failed (${err?.message ?? err}) — no preview URL for this port`);
          return null;
        }
      }

      return `${serviceName}.${ns}.svc.cluster.local:${port}`;
    },

    // Same Service-per-instance-per-port pattern as previewUrl(), but
    // NodePort instead of ClusterIP: bootNetworkedAgent({fleet})'s manager
    // agent dials this from wherever it's actually running (a laptop, CI),
    // not from inside the cluster, so an in-cluster-only DNS name (what
    // previewUrl() returns) is useless here. A distinct Service name/prefix
    // keeps the two from colliding if both are ever requested for the same
    // instance+port.
    async rpcUrl(handle: DeployHandle, port: number) {
      if (!(handle instanceof K8sDeployHandle) || !handle.instanceId) return null;
      const k8s = await loadK8s();
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);

      const serviceName = `berth-rpc-${handle.instanceId.slice(0, 12)}-${port}`;
      const ns = namespace();
      let nodePort: number | undefined;
      try {
        const service = await withTimeout<any>(
          coreApi.createNamespacedService({
            namespace: ns,
            body: {
              metadata: { name: serviceName },
              spec: {
                selector: { [INSTANCE_LABEL]: handle.instanceId },
                ports: [{ port, targetPort: port }],
                type: "NodePort",
              },
            },
          }),
          DEPLOY_CREATE_TIMEOUT_MS,
          `k8s createNamespacedService("${serviceName}")`,
        );
        nodePort = service.spec?.ports?.[0]?.nodePort;
      } catch (err: any) {
        if (err?.body?.reason !== "AlreadyExists" && err?.code !== 409) {
          console.error(`[adapter-k8s] rpcUrl: createNamespacedService("${serviceName}") failed (${err?.message ?? err}) — no RPC URL for this port`);
          return null;
        }
        // Already created by an earlier rpcUrl() call for this same
        // instance/port — the node port the API server assigned isn't
        // available on this branch (the create() call itself is what just
        // failed), so read the existing Service back to recover it.
        const existing = await withTimeout<any>(
          coreApi.readNamespacedService({ name: serviceName, namespace: ns }),
          DEPLOY_READ_TIMEOUT_MS,
          `k8s readNamespacedService("${serviceName}")`,
        );
        nodePort = existing.spec?.ports?.[0]?.nodePort;
      }

      if (!nodePort) {
        console.error(`[adapter-k8s] rpcUrl: Service "${serviceName}" has no assigned nodePort yet — no RPC URL for this port`);
        return null;
      }

      const nodeIp = await reachableNodeIp(coreApi);
      if (!nodeIp) {
        console.error(`[adapter-k8s] rpcUrl: no node with a reachable address found — no RPC URL for this port`);
        return null;
      }

      return `http://${nodeIp}:${nodePort}`;
    },
  };
}

/**
 * A NodePort Service is reachable at *any* node's IP on the assigned port —
 * not a Service-specific address — so this only needs one working node
 * address, not a specific node. Prefers ExternalIP (the only address type
 * actually reachable from outside the cluster's own network on most real
 * clusters) and falls back to InternalIP, which is what makes this testable
 * against a local `kind` cluster at all (kind's InternalIP is the kind node
 * container's own Docker-network address, reachable from the host running
 * kind/tests). On a real cloud cluster with no ExternalIP and a firewalled
 * InternalIP, this legitimately has no answer — same class of caveat
 * previewUrl() already documents for its own Ingress/LoadBalancer gap.
 */
async function reachableNodeIp(coreApi: any): Promise<string | null> {
  const nodeList = await withTimeout<any>(coreApi.listNode(), DEPLOY_READ_TIMEOUT_MS, "k8s listNode()");
  const addresses: Array<{ type: string; address: string }> = nodeList.items.flatMap((node: any) => node.status?.addresses ?? []);
  const external = addresses.find((a) => a.type === "ExternalIP");
  if (external) return external.address;
  const internal = addresses.find((a) => a.type === "InternalIP");
  return internal?.address ?? null;
}
