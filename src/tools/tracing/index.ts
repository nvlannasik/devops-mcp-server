import * as h from "./handlers.js";
import type { Tool } from "../types.js";

const tools: Tool[] = [
  {
    name: "tracing_search",
    description:
      "Search distributed traces (Tempo/Jaeger). Find slow or failing requests by service, minimum duration, and time window. Returns trace summaries — use tracing_get_trace for span detail.",
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Service name to filter by (REQUIRED for Jaeger backend, optional for Tempo)",
        },
        minDurationMs: { type: "number", description: "Only traces slower than this many milliseconds" },
        start: { type: "string", description: "Window start — RFC3339 or Unix seconds (default: 1h ago)" },
        end: { type: "string", description: "Window end — RFC3339 or Unix seconds (default: now)" },
        limit: { type: "number", description: "Max traces returned (default: 20)" },
      },
    },
    handler: h.searchTraces,
  },
  {
    name: "tracing_get_trace",
    description:
      "Get the full span tree for one trace by ID. Returns normalized spans (service, name, durationMs, parent, error) to pinpoint which span/service is slow or failing.",
    inputSchema: {
      type: "object",
      required: ["traceId"],
      properties: {
        traceId: { type: "string", description: "Trace ID from tracing_search" },
      },
    },
    handler: h.getTrace,
  },
  {
    name: "tracing_list_services",
    description: "List service names known to the tracing backend (discovery before searching).",
    inputSchema: { type: "object", properties: {} },
    handler: h.listServices,
  },
];

export default tools;
