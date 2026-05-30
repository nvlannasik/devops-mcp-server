import * as h from "./handlers.js";
import type { Tool } from "../types.js";

const tools: Tool[] = [
  {
    name: "loki_query",
    description: "Execute an instant LogQL query against Loki",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: 'LogQL query (e.g. {app="nginx"} |= "error")' },
        limit: { type: "number", description: "Max log lines (default: 100)" },
        time: { type: "string", description: "Evaluation timestamp (nanoseconds or RFC3339)" },
        direction: { type: "string", enum: ["forward", "backward"], description: "Log order (default: backward)" },
      },
    },
    handler: h.queryLogs,
  },
  {
    name: "loki_query_range",
    description: "Query logs over a time range from Loki",
    inputSchema: {
      type: "object",
      required: ["query", "start", "end"],
      properties: {
        query: { type: "string", description: "LogQL query" },
        start: { type: "string", description: "Start time (RFC3339 or Unix nanoseconds)" },
        end: { type: "string", description: "End time (RFC3339 or Unix nanoseconds)" },
        limit: { type: "number", description: "Max log lines (default: 100)" },
        direction: { type: "string", enum: ["forward", "backward"], description: "Log order (default: backward)" },
      },
    },
    handler: h.queryLogsRange,
  },
  {
    name: "loki_get_labels",
    description: "Get all label names available in Loki",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", description: "Start time" },
        end: { type: "string", description: "End time" },
      },
    },
    handler: h.getLabels,
  },
  {
    name: "loki_get_label_values",
    description: "Get values for a specific label in Loki",
    inputSchema: {
      type: "object",
      required: ["label"],
      properties: {
        label: { type: "string", description: "Label name (e.g. app, namespace, pod)" },
        start: { type: "string", description: "Start time" },
        end: { type: "string", description: "End time" },
      },
    },
    handler: h.getLabelValues,
  },
  {
    name: "loki_get_streams",
    description: "List active log streams matching a label selector",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: 'Label selector (e.g. {app="nginx"})' },
        start: { type: "string", description: "Start time" },
        end: { type: "string", description: "End time" },
        limit: { type: "number", description: "Max streams (default: 100)" },
      },
    },
    handler: h.getStreams,
  },
  {
    name: "loki_get_stats",
    description: "Get ingestion statistics for a log stream (bytes, lines, chunks)",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: 'Label selector (e.g. {app="nginx"})' },
        start: { type: "string", description: "Start time" },
        end: { type: "string", description: "End time" },
      },
    },
    handler: h.getStats,
  },
];

export default tools;
