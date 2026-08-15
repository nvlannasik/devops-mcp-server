import { z } from "zod";
import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NS } from "../schemas.js";

// Rollout status — the "is this deploy progressing / stuck?" view. Deployment/StatefulSet/
// DaemonSet expose different status fields; normalize them into one shape (desired / updated /
// ready / available / unavailable + conditions). State only — no metrics.

const KINDS = ["deployment", "statefulset", "daemonset"] as const;
type Kind = (typeof KINDS)[number];

interface WorkloadLike {
  metadata?: { name?: string; namespace?: string };
  spec?: { replicas?: number; strategy?: { type?: string }; updateStrategy?: { type?: string } };
  status?: {
    updatedReplicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    unavailableReplicas?: number;
    desiredNumberScheduled?: number;
    updatedNumberScheduled?: number;
    numberReady?: number;
    numberAvailable?: number;
    numberUnavailable?: number;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  };
}

// exported for unit tests
export function shapeRollout(kind: Kind, w: WorkloadLike) {
  const s = w.status ?? {};
  const n =
    kind === "daemonset"
      ? { desired: s.desiredNumberScheduled ?? 0, updated: s.updatedNumberScheduled ?? 0, ready: s.numberReady ?? 0, available: s.numberAvailable ?? 0, unavailable: s.numberUnavailable ?? 0 }
      : {
          desired: w.spec?.replicas ?? 0,
          updated: s.updatedReplicas ?? 0,
          ready: s.readyReplicas ?? 0,
          available: s.availableReplicas ?? 0,
          unavailable: s.unavailableReplicas ?? 0,
        };
  return {
    kind,
    name: w.metadata?.name,
    namespace: w.metadata?.namespace,
    ...n,
    complete: n.desired === n.updated && n.desired === n.ready && n.unavailable === 0,
    strategy: w.spec?.strategy?.type ?? w.spec?.updateStrategy?.type,
    conditions: s.conditions?.map((c) => ({ type: c.type, status: c.status, reason: c.reason, message: c.message })),
  };
}

export const getRolloutStatus = (input: unknown) => {
  const { namespace, name, kind } = NS.extend({ name: z.string().min(1), kind: z.enum(KINDS).default("deployment") }).parse(input);
  return withUpstream("kubernetes", `Failed to get rollout status for ${kind} ${namespace}/${name}`, async () => {
    const api = getApi(k8s.AppsV1Api);
    const w =
      kind === "deployment"
        ? await api.readNamespacedDeployment({ name, namespace })
        : kind === "statefulset"
          ? await api.readNamespacedStatefulSet({ name, namespace })
          : await api.readNamespacedDaemonSet({ name, namespace });
    return shapeRollout(kind, w as WorkloadLike);
  });
};

// ReplicaSets in a namespace — rollout history: the active RS (desired>0) vs stale ones,
// grouped by owning Deployment + revision. Old RS with unready pods = a failed rollout left behind.
export const listReplicaSets = (input: unknown) => {
  const { namespace } = NS.parse(input);
  return withUpstream("kubernetes", "Failed to list ReplicaSets", async () => {
    const res = await getApi(k8s.AppsV1Api).listNamespacedReplicaSet({ namespace });
    return res.items.map((rs) => ({
      name: rs.metadata!.name,
      namespace: rs.metadata!.namespace,
      owner: rs.metadata!.ownerReferences?.find((o) => o.controller)?.name,
      revision: rs.metadata!.annotations?.["deployment.kubernetes.io/revision"],
      desired: rs.spec!.replicas ?? 0,
      ready: rs.status!.readyReplicas ?? 0,
      age: rs.metadata!.creationTimestamp,
    }));
  });
};
