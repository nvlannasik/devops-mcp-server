import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NS } from "../schemas.js";

export const listJobs = (input: unknown) => {
  const { namespace } = NS.parse(input);
  return withUpstream("kubernetes", "Failed to list jobs", async () => {
    const res = await getApi(k8s.BatchV1Api).listNamespacedJob({ namespace });
    return res.items.map((j) => ({
      name: j.metadata!.name,
      namespace: j.metadata!.namespace,
      status: j.status!.active ? "active" : j.status!.succeeded ? "succeeded" : "failed",
      succeeded: j.status!.succeeded ?? 0,
      failed: j.status!.failed ?? 0,
      startTime: j.status!.startTime,
      completionTime: j.status!.completionTime,
    }));
  });
};

export const listCronJobs = (input: unknown) => {
  const { namespace } = NS.parse(input);
  return withUpstream("kubernetes", "Failed to list cronjobs", async () => {
    const res = await getApi(k8s.BatchV1Api).listNamespacedCronJob({ namespace });
    return res.items.map((c) => ({
      name: c.metadata!.name,
      namespace: c.metadata!.namespace,
      schedule: c.spec!.schedule,
      suspended: c.spec!.suspend ?? false,
      lastSchedule: c.status!.lastScheduleTime,
      activeJobs: c.status!.active?.length ?? 0,
    }));
  });
};
