import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NS } from "../schemas.js";

export const listConfigMaps = (input: unknown) => {
  const { namespace } = NS.parse(input);
  return withUpstream("kubernetes", "Failed to list configmaps", async () => {
    const res = await getApi(k8s.CoreV1Api).listNamespacedConfigMap({ namespace });
    return res.items.map((cm) => ({
      name: cm.metadata!.name,
      namespace: cm.metadata!.namespace,
      keys: Object.keys(cm.data ?? {}),
      data: cm.data ?? {},
      age: cm.metadata!.creationTimestamp,
    }));
  });
};

export const listSecrets = (input: unknown) => {
  const { namespace } = NS.parse(input);
  return withUpstream("kubernetes", "Failed to list secrets", async () => {
    const res = await getApi(k8s.CoreV1Api).listNamespacedSecret({ namespace });
    return res.items.map((s) => ({
      name: s.metadata!.name,
      namespace: s.metadata!.namespace,
      type: s.type,
      keys: Object.keys(s.data ?? {}),
      age: s.metadata!.creationTimestamp,
    }));
  });
};
