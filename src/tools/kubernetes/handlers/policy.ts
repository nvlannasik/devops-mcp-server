import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NS } from "../schemas.js";

// PodDisruptionBudgets — for "can't drain/evict" or scaling stuck. disruptionsAllowed=0 means
// no voluntary disruption is permitted right now (blocks node drain / rolling operations).
export const listPDBs = (input: unknown) => {
  const { namespace } = NS.parse(input);
  return withUpstream("kubernetes", "Failed to list PodDisruptionBudgets", async () => {
    const res = await getApi(k8s.PolicyV1Api).listNamespacedPodDisruptionBudget({ namespace });
    return res.items.map((p) => ({
      name: p.metadata!.name,
      namespace: p.metadata!.namespace,
      minAvailable: p.spec!.minAvailable,
      maxUnavailable: p.spec!.maxUnavailable,
      currentHealthy: p.status?.currentHealthy,
      desiredHealthy: p.status?.desiredHealthy,
      disruptionsAllowed: p.status?.disruptionsAllowed, // 0 → blocks drain/eviction
      age: p.metadata!.creationTimestamp,
    }));
  });
};
