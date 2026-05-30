import * as h from "./handlers.js";
import type { Tool } from "../types.js";

const tools: Tool[] = [
  {
    name: "prometheus_query",
    description: "Execute an instant PromQL query",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "PromQL query expression" },
        time: { type: "string", description: "Evaluation timestamp (RFC3339 or Unix)" },
      },
    },
    handler: h.query,
  },
  {
    name: "prometheus_query_range",
    description: "Execute a range PromQL query",
    inputSchema: {
      type: "object",
      required: ["query", "start", "end", "step"],
      properties: {
        query: { type: "string", description: "PromQL query expression" },
        start: { type: "string", description: "Start time (RFC3339 or Unix)" },
        end: { type: "string", description: "End time (RFC3339 or Unix)" },
        step: { type: "string", description: "Resolution step (e.g. 15s, 1m)" },
      },
    },
    handler: h.queryRange,
  },
  {
    name: "prometheus_get_alerts",
    description: "Get all active alerts from Prometheus",
    inputSchema: { type: "object", properties: {} },
    handler: h.getAlerts,
  },
  {
    name: "prometheus_get_targets",
    description: "Get scrape targets and their health status",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["active", "dropped", "any"], description: "Filter by state" },
      },
    },
    handler: h.getTargets,
  },
  {
    name: "prometheus_get_rules",
    description: "Get all alerting and recording rules",
    inputSchema: { type: "object", properties: {} },
    handler: h.getRules,
  },
  {
    name: "prometheus_get_metadata",
    description: "Get metric metadata (type, unit, help text)",
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string", description: "Metric name to filter (optional)" },
      },
    },
    handler: h.getMetadata,
  },
  {
    name: "prometheus_list_metric_names",
    description: "List all available metric names",
    inputSchema: { type: "object", properties: {} },
    handler: h.listMetricNames,
  },
];

export default tools;
