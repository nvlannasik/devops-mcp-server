import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";

export const listNamespaces = () =>
  withUpstream("kubernetes", "Failed to list namespaces", async () => {
    const res = await getApi(k8s.CoreV1Api).listNamespace();
    return res.items.map((ns) => ({
      name: ns.metadata!.name,
      status: ns.status!.phase,
      age: ns.metadata!.creationTimestamp,
    }));
  });
