import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NS } from "../schemas.js";

export const listHPAs = (input: unknown) => {
  const { namespace } = NS.parse(input);
  return withUpstream("kubernetes", "Failed to list HPAs", async () => {
    const res = await getApi(k8s.AutoscalingV2Api).listNamespacedHorizontalPodAutoscaler({ namespace });
    return res.items.map((h) => ({
      name: h.metadata!.name,
      namespace: h.metadata!.namespace,
      target: `${h.spec!.scaleTargetRef.kind}/${h.spec!.scaleTargetRef.name}`,
      minReplicas: h.spec!.minReplicas,
      maxReplicas: h.spec!.maxReplicas,
      currentReplicas: h.status!.currentReplicas,
      desiredReplicas: h.status!.desiredReplicas,
      age: h.metadata!.creationTimestamp,
    }));
  });
};
