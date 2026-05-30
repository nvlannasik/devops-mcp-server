import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NS } from "../schemas.js";

export const listServiceAccounts = (input: unknown) => {
  const { namespace } = NS.parse(input);
  return withUpstream("kubernetes", "Failed to list service accounts", async () => {
    const res = await getApi(k8s.CoreV1Api).listNamespacedServiceAccount({ namespace });
    return res.items.map((sa) => ({
      name: sa.metadata!.name,
      namespace: sa.metadata!.namespace,
      secrets: sa.secrets?.map((s) => s.name) ?? [],
      age: sa.metadata!.creationTimestamp,
    }));
  });
};
