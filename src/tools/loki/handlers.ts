import { z } from "zod";
import { getClient } from "./client.js";
import { explainEmptyLogs, parseStreams, type EmptyLogs, type LogEntry } from "../../utils/loki/index.js";
import { withUpstream } from "../../utils/errors/index.js";

const TimeRange = z.object({ start: z.string().optional(), end: z.string().optional() });

/**
 * An empty answer gets one follow-up question to Loki — "which namespaces do you hold ANY line
 * from, in this same window?" — so the caller learns whether the query or the pipeline came back
 * empty. See explainEmptyLogs for why that difference is the whole point.
 *
 * Only on empty: a non-empty answer is returned byte-for-byte as before, so nothing that already
 * works pays for this. And the probe is a courtesy, never a new way to fail — if it errors, the
 * caller gets the plain `[]` it always got, rather than an answered query turning into a failed one.
 */
async function explained(query: string, entries: LogEntry[], window: { start?: string; end?: string }): Promise<LogEntry[] | EmptyLogs> {
  if (entries.length > 0) return entries;
  try {
    const params: Record<string, string> = {};
    if (window.start) params.start = window.start;
    if (window.end) params.end = window.end;
    const res = await getClient().get("/loki/api/v1/label/namespace/values", { params });
    return explainEmptyLogs(query, Array.isArray(res.data?.data) ? res.data.data : []);
  } catch {
    return entries;
  }
}

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
    // No start: an instant query has no window of its own, so the probe uses Loki's default one.
    return explained(query, parseStreams(res.data.data.result), { end: time });
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
    return explained(query, parseStreams(res.data.data.result), { start, end });
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
