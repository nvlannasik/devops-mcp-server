import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";

export const listNodes = () =>
  withUpstream("kubernetes", "Failed to list nodes", async () => {
    const res = await getApi(k8s.CoreV1Api).listNode();
    return res.items.map((n) => ({
      name: n.metadata!.name,
      status: n.status!.conditions?.find((c) => c.type === "Ready")?.status,
      roles: Object.keys(n.metadata!.labels ?? {})
        .filter((l) => l.startsWith("node-role.kubernetes.io/"))
        .map((l) => l.replace("node-role.kubernetes.io/", "")),
      capacity: n.status!.capacity,
      allocatable: n.status!.allocatable,
      age: n.metadata!.creationTimestamp,
    }));
  });
