import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NS } from "../schemas.js";

// Containers (name + image) belong in every workload listing: "what image tag runs
// where" is unanswerable without them, and image-change remediations need the current
// repository in context (the proposal rule is "keep the repo, change only the tag").
const containersOf = (tpl?: { spec?: { containers?: Array<{ name?: string; image?: string }> } }) =>
  (tpl?.spec?.containers ?? []).map((c) => ({ name: c.name, image: c.image }));

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
      containers: containersOf(d.spec!.template),
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
      containers: containersOf(s.spec!.template),
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
      containers: containersOf(d.spec!.template),
      age: d.metadata!.creationTimestamp,
    }));
  });
};
