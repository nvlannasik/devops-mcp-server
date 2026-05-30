import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";

export const listCRDs = () =>
  withUpstream("kubernetes", "Failed to list CRDs", async () => {
    const res = await getApi(k8s.ApiextensionsV1Api).listCustomResourceDefinition();
    return res.items.map((c) => ({
      name: c.metadata!.name,
      group: c.spec.group,
      scope: c.spec.scope,
      versions: c.spec.versions.map((v) => ({ name: v.name, served: v.served, storage: v.storage })),
      established: c.status!.conditions?.find((cond) => cond.type === "Established")?.status,
      age: c.metadata!.creationTimestamp,
    }));
  });
