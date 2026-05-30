import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NS } from "../schemas.js";

export const listPVCs = (input: unknown) => {
  const { namespace } = NS.parse(input);
  return withUpstream("kubernetes", "Failed to list PVCs", async () => {
    const res = await getApi(k8s.CoreV1Api).listNamespacedPersistentVolumeClaim({ namespace });
    return res.items.map((p) => ({
      name: p.metadata!.name,
      namespace: p.metadata!.namespace,
      status: p.status!.phase,
      capacity: p.status!.capacity?.storage,
      storageClass: p.spec!.storageClassName,
      accessModes: p.spec!.accessModes,
      age: p.metadata!.creationTimestamp,
    }));
  });
};
