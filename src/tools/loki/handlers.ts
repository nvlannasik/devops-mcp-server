import { z } from "zod";
import { getClient } from "./client.js";
import { parseStreams } from "../../utils/loki/index.js";
import { withUpstream } from "../../utils/errors/index.js";

const TimeRange = z.object({ start: z.string().optional(), end: z.string().optional() });

export const queryLogs = (input: unknown) => {
  const { query, limit, time, direction } = z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().default(100),
    time: z.string().optional(),
    direction: z.enum(["forward", "backward"]).default("backward"),
  }).parse(input);
  return withUpstream("loki", "Loki query failed", async () => {
    const params: Record<string, unknown> = { query, limit, direction };
    if (time) params.time = time;
    const res = await getClient().get("/loki/api/v1/query", { params });
    return parseStreams(res.data.data.result);
  });
};

export const queryLogsRange = (input: unknown) => {
  const { query, start, end, limit, direction } = z.object({
    query: z.string().min(1),
    start: z.string(),
    end: z.string(),
    limit: z.number().int().positive().default(100),
    direction: z.enum(["forward", "backward"]).default("backward"),
  }).parse(input);
  return withUpstream("loki", "Loki range query failed", async () => {
    const res = await getClient().get("/loki/api/v1/query_range", { params: { query, start, end, limit, direction } });
    return parseStreams(res.data.data.result);
  });
};

export const getLabels = (input: unknown) => {
  const { start, end } = TimeRange.parse(input);
  return withUpstream("loki", "Failed to get Loki labels", async () => {
    const params: Record<string, string> = {};
    if (start) params.start = start;
    if (end) params.end = end;
    const res = await getClient().get("/loki/api/v1/labels", { params });
    return res.data.data;
  });
};

export const getLabelValues = (input: unknown) => {
  const { label, start, end } = TimeRange.extend({ label: z.string().min(1) }).parse(input);
  return withUpstream("loki", `Failed to get Loki label values for ${label}`, async () => {
    const params: Record<string, string> = {};
    if (start) params.start = start;
    if (end) params.end = end;
    const res = await getClient().get(`/loki/api/v1/label/${label}/values`, { params });
    return res.data.data;
  });
};

export const getStreams = (input: unknown) => {
  const { query, start, end, limit } = TimeRange.extend({
    query: z.string().min(1),
    limit: z.number().int().positive().default(100),
  }).parse(input);
  return withUpstream("loki", "Failed to get Loki streams", async () => {
    const params: Record<string, unknown> = { query, limit };
    if (start) params.start = start;
    if (end) params.end = end;
    const res = await getClient().get("/loki/api/v1/series", { params });
    return res.data.data;
  });
};

export const getStats = (input: unknown) => {
  const { query, start, end } = TimeRange.extend({ query: z.string().min(1) }).parse(input);
  return withUpstream("loki", "Failed to get Loki stats", async () => {
    const params: Record<string, string> = { query };
    if (start) params.start = start;
    if (end) params.end = end;
    const res = await getClient().get("/loki/api/v1/index/stats", { params });
    return res.data.data;
  });
};
