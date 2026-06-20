import { z } from "zod";
import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NSField } from "../schemas.js";
import config from "../../../config/index.js";

const EventInput = NSField.extend({
  since_minutes: z.number().int().positive().optional(),
});

export const listEvents = (input: unknown) => {
  const { namespace, field_selector, since_minutes } = EventInput.parse(input);
  return withUpstream("kubernetes", "Failed to list events", async () => {
    const res = await getApi(k8s.CoreV1Api).listNamespacedEvent({
      namespace,
      fieldSelector: field_selector,
      limit: config.k8sListLimit,
      timeoutSeconds: Math.ceil(config.upstreamTimeoutMs / 1000),
    });
    const cutoff = since_minutes ? new Date(Date.now() - since_minutes * 60 * 1000) : null;

    return res.items
      .filter((e) => {
        if (!cutoff) return true;
        const lastTime = e.lastTimestamp ? new Date(e.lastTimestamp) : null;
        return lastTime ? lastTime >= cutoff : true;
      })
      .map((e) => ({
        type: e.type,
        reason: e.reason,
        message: e.message,
        object: `${e.involvedObject.kind}/${e.involvedObject.name}`,
        count: e.count,
        firstTime: e.firstTimestamp,
        lastTime: e.lastTimestamp,
      }));
  });
};
