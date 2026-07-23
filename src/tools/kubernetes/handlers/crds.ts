import { z } from "zod";
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

// ---- custom resource instances (the objects, not the definitions) ----

const CR = z.object({
  group: z.string().min(1),
  version: z.string().min(1),
  plural: z.string().min(1),
  namespace: z.string().optional(), // omit for cluster-scoped resources
  name: z.string().optional(), // omit to list (compact); set to get the full object
});

type CrItem = {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string };
  status?: { conditions?: Array<{ type?: string; status?: string; message?: string }> };
};

// exported for unit tests — a compact row per CR so big lists don't flood the context;
// the Ready condition is the near-universal health signal (Flux, cert-manager, ...)
export function compactCustomResources(items: CrItem[]) {
  return items.map((i) => {
    const ready = i.status?.conditions?.find((c) => c.type === "Ready");
    return {
      name: i.metadata?.name,
      namespace: i.metadata?.namespace,
      ready: ready?.status,
      message: ready?.message?.slice(0, 200),
      age: i.metadata?.creationTimestamp,
    };
  });
}

export const getCustomResources = (input: unknown) => {
  const { group, version, plural, namespace, name } = CR.parse(input);
  return withUpstream("kubernetes", `Failed to read ${plural}.${group}`, async () => {
    const api = getApi(k8s.CustomObjectsApi);
    if (name) {
      // full object — spec + status (e.g. a HelmRelease's chart, values, sourceRef)
      return namespace
        ? api.getNamespacedCustomObject({ group, version, namespace, plural, name })
        : api.getClusterCustomObject({ group, version, plural, name });
    }
    const res = namespace
      ? await api.listNamespacedCustomObject({ group, version, namespace, plural })
      : await api.listClusterCustomObject({ group, version, plural });
    return compactCustomResources(((res as { items?: CrItem[] }).items ?? []) as CrItem[]);
  });
};
