import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NS } from "../schemas.js";

export const listResourceQuotas = (input: unknown) => {
  const { namespace } = NS.parse(input);
  return withUpstream("kubernetes", "Failed to list resource quotas", async () => {
    const res = await getApi(k8s.CoreV1Api).listNamespacedResourceQuota({ namespace });
    return res.items.map((q) => ({
      name: q.metadata!.name,
      namespace: q.metadata!.namespace,
      hard: q.status!.hard,
      used: q.status!.used,
    }));
  });
};
