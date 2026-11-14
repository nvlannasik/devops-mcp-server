import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";

export interface NodeLike {
  metadata?: { name?: string; labels?: Record<string, string>; creationTimestamp?: unknown };
  spec?: { unschedulable?: boolean; taints?: Array<{ key?: string; value?: string; effect?: string }> };
  status?: {
    conditions?: Array<{ type?: string; status?: string }>;
    capacity?: Record<string, string>;
    allocatable?: Record<string, string>;
  };
}

/**
 * One node as the listing reports it. `unschedulable`, `taints` and `pressure` are here, not only
 * in k8s_describe_node, because they are what a Pending pod or a node alert turns on and the list
 * is the call the model makes first.
 *
 * Bench A16, 2026-11-14, five attempts of five: a workload pinned to a cordoned node, the scheduler
 * reporting `untolerated taint {node.kubernetes.io/unschedulable}`, and the listing saying only
 * `status: "True"`. Every RCA read the taint as a misconfigured toleration and told a human to add
 * one; none saw that the node was cordoned. The kubelet's own taints (`node.kubernetes.io/*`) say
 * which condition put them there, so the list names them as-is.
 *
 * exported for the test
 */
export function shapeNodeRow(n: NodeLike) {
  const conditions = n.status?.conditions ?? [];
  return {
    name: n.metadata?.name,
    status: conditions.find((c) => c.type === "Ready")?.status,
    // A cordon. `false` stated rather than omitted, so "not cordoned" is a fact the model read.
    unschedulable: n.spec?.unschedulable ?? false,
    taints: (n.spec?.taints ?? []).map((t) => `${t.key}${t.value ? `=${t.value}` : ""}:${t.effect}`),
    // The pressure conditions that are TRUE — healthy is an empty list, not three "False" rows.
    pressure: conditions.filter((c) => c.type !== "Ready" && c.status === "True").map((c) => c.type),
    roles: Object.keys(n.metadata?.labels ?? {})
      .filter((l) => l.startsWith("node-role.kubernetes.io/"))
      .map((l) => l.replace("node-role.kubernetes.io/", "")),
    capacity: n.status?.capacity,
    allocatable: n.status?.allocatable,
    age: n.metadata?.creationTimestamp,
  };
}

export const listNodes = () =>
  withUpstream("kubernetes", "Failed to list nodes", async () => {
    const res = await getApi(k8s.CoreV1Api).listNode();
    return res.items.map((n) => shapeNodeRow(n as NodeLike));
  });
