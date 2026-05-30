import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NSField } from "../schemas.js";

export const listEvents = (input: unknown) => {
  const { namespace, field_selector } = NSField.parse(input);
  return withUpstream("kubernetes", "Failed to list events", async () => {
    const res = await getApi(k8s.CoreV1Api).listNamespacedEvent({ namespace, fieldSelector: field_selector });
    return res.items.map((e) => ({
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
