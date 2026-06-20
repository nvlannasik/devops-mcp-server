import { z } from "zod";
import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NS, NSLabel } from "../schemas.js";
import config from "../../../config/index.js";

const LIST_TIMEOUT_SEC = Math.ceil(config.upstreamTimeoutMs / 1000);

export const listPods = (input: unknown) => {
  const { namespace, label_selector } = NSLabel.parse(input);
  return withUpstream("kubernetes", "Failed to list pods", async () => {
    const res = await getApi(k8s.CoreV1Api).listNamespacedPod({
      namespace,
      labelSelector: label_selector,
      limit: config.k8sListLimit,
      timeoutSeconds: LIST_TIMEOUT_SEC,
    });
    return res.items.map((pod) => ({
      name: pod.metadata!.name,
      namespace: pod.metadata!.namespace,
      status: pod.status!.phase,
      ready: pod.status!.containerStatuses?.every((c) => c.ready) ?? false,
      restarts: pod.status!.containerStatuses?.reduce((sum, c) => sum + c.restartCount, 0) ?? 0,
      node: pod.spec!.nodeName,
      age: pod.metadata!.creationTimestamp,
    }));
  });
};

export const getPodLogs = (input: unknown) => {
  const { pod_name, namespace, container, tail_lines } = NS.extend({
    pod_name: z.string().min(1),
    container: z.string().optional(),
    tail_lines: z.number().int().positive().default(100),
  }).parse(input);
  return withUpstream("kubernetes", `Failed to get logs for pod ${pod_name}`, async () => {
    const res = await getApi(k8s.CoreV1Api).readNamespacedPodLog({
      name: pod_name, namespace, container, tailLines: tail_lines,
    });
    return { logs: res };
  });
};
