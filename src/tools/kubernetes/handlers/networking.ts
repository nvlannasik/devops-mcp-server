import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NS } from "../schemas.js";

export const listServices = (input: unknown) => {
  const { namespace } = NS.parse(input);
  return withUpstream("kubernetes", "Failed to list services", async () => {
    const res = await getApi(k8s.CoreV1Api).listNamespacedService({ namespace });
    return res.items.map((s) => ({
      name: s.metadata!.name,
      namespace: s.metadata!.namespace,
      type: s.spec!.type,
      clusterIP: s.spec!.clusterIP,
      externalIP: s.status!.loadBalancer?.ingress?.[0]?.ip ?? null,
      ports: s.spec!.ports?.map((p) => `${p.port}:${p.targetPort}/${p.protocol}`),
      age: s.metadata!.creationTimestamp,
    }));
  });
};

export const listIngresses = (input: unknown) => {
  const { namespace } = NS.parse(input);
  return withUpstream("kubernetes", "Failed to list ingresses", async () => {
    const res = await getApi(k8s.NetworkingV1Api).listNamespacedIngress({ namespace });
    return res.items.map((i) => ({
      name: i.metadata!.name,
      namespace: i.metadata!.namespace,
      ingressClass: i.spec!.ingressClassName,
      rules: i.spec!.rules?.map((r) => ({
        host: r.host,
        paths: r.http?.paths?.map((p) => `${p.path} → ${p.backend?.service?.name}:${p.backend?.service?.port?.number}`),
      })),
      age: i.metadata!.creationTimestamp,
    }));
  });
};
