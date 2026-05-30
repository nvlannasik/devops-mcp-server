import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NS } from "../schemas.js";

export const listDeployments = (input: unknown) => {
  const { namespace } = NS.parse(input);
  return withUpstream("kubernetes", "Failed to list deployments", async () => {
    const res = await getApi(k8s.AppsV1Api).listNamespacedDeployment({ namespace });
    return res.items.map((d) => ({
      name: d.metadata!.name,
      namespace: d.metadata!.namespace,
      replicas: d.spec!.replicas,
      readyReplicas: d.status!.readyReplicas ?? 0,
      availableReplicas: d.status!.availableReplicas ?? 0,
      age: d.metadata!.creationTimestamp,
    }));
  });
};

export const listStatefulSets = (input: unknown) => {
  const { namespace } = NS.parse(input);
  return withUpstream("kubernetes", "Failed to list statefulsets", async () => {
    const res = await getApi(k8s.AppsV1Api).listNamespacedStatefulSet({ namespace });
    return res.items.map((s) => ({
      name: s.metadata!.name,
      namespace: s.metadata!.namespace,
      replicas: s.spec!.replicas,
      readyReplicas: s.status!.readyReplicas ?? 0,
      age: s.metadata!.creationTimestamp,
    }));
  });
};

export const listDaemonSets = (input: unknown) => {
  const { namespace } = NS.parse(input);
  return withUpstream("kubernetes", "Failed to list daemonsets", async () => {
    const res = await getApi(k8s.AppsV1Api).listNamespacedDaemonSet({ namespace });
    return res.items.map((d) => ({
      name: d.metadata!.name,
      namespace: d.metadata!.namespace,
      desired: d.status!.desiredNumberScheduled,
      ready: d.status!.numberReady,
      available: d.status!.numberAvailable ?? 0,
      age: d.metadata!.creationTimestamp,
    }));
  });
};
