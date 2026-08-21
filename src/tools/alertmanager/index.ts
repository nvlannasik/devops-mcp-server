import * as h from "./handlers.js";
import type { Tool } from "../types.js";

const tools: Tool[] = [
  {
    name: "alertmanager_get_alerts",
    description:
      "Get every alert Alertmanager is currently holding, in Alertmanager's own groups. This is " +
      "the cluster-wide view of what is firing across ALL alert sources (Prometheus rules, " +
      "log-based rules, anything else routed here) — use it to establish blast radius: is this " +
      "incident isolated, or one symptom of something larger? Each alert is labelled with its " +
      "status: active, silenced (a human muted the notification — the problem is still firing), " +
      "or inhibited (suppressed by a higher-severity alert). Returns a summary with complete " +
      "counts plus per-group detail.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional label matchers, Alertmanager syntax, e.g. ['namespace=\"payments\"'] or " +
            "['severity=~\"critical|warning\"']. Omit to see the whole cluster — which is what " +
            "blast radius needs.",
        },
      },
    },
    handler: h.getAlerts,
  },
];

export default tools;
