import { z } from "zod";
import { getClient } from "./client.js";
import { withUpstream } from "../../utils/errors/index.js";

type AlertRecord = { labels: Record<string, string>; annotations?: Record<string, string>; state: unknown; activeAt: unknown };
type TargetRecord = { labels: Record<string, string>; health: unknown; lastError: unknown; lastScrape: unknown };
type RuleRecord = { labels?: Record<string, string>; type: unknown; name: unknown; query: unknown; duration: unknown; state: unknown; health: unknown };
type GroupRecord = { name: unknown; file: unknown; rules: RuleRecord[] };

export const query = (input: unknown) => {
  const { query, time } = z.object({ query: z.string().min(1), time: z.string().optional() }).parse(input);
  return withUpstream("prometheus", "Prometheus query failed", async () => {
    const params: Record<string, string> = { query };
    if (time) params.time = time;
    const res = await getClient().get("/api/v1/query", { params });
    return res.data.data;
  });
};

export const queryRange = (input: unknown) => {
  const { query, start, end, step } = z.object({
    query: z.string().min(1),
    start: z.string(),
    end: z.string(),
    step: z.string(),
  }).parse(input);
  return withUpstream("prometheus", "Prometheus range query failed", async () => {
    const res = await getClient().get("/api/v1/query_range", { params: { query, start, end, step } });
    return res.data.data;
  });
};

export const getAlerts = () =>
  withUpstream("prometheus", "Failed to get Prometheus alerts", async () => {
    const res = await getClient().get("/api/v1/alerts");
    return res.data.data.alerts.map((a: AlertRecord) => ({
      name: a.labels.alertname,
      state: a.state,
      severity: a.labels.severity,
      summary: a.annotations?.summary,
      labels: a.labels,
      activeAt: a.activeAt,
    }));
  });

export const getTargets = (input: unknown) => {
  const { state } = z.object({ state: z.enum(["active", "dropped", "any"]).default("active") }).parse(input);
  return withUpstream("prometheus", "Failed to get Prometheus targets", async () => {
    const res = await getClient().get("/api/v1/targets", { params: { state } });
    return {
      activeTargets: res.data.data.activeTargets?.map((t: TargetRecord) => ({
        job: t.labels.job,
        instance: t.labels.instance,
        health: t.health,
        lastError: t.lastError || null,
        lastScrape: t.lastScrape,
      })),
      droppedTargets: res.data.data.droppedTargets?.length ?? 0,
    };
  });
};

export const getRules = () =>
  withUpstream("prometheus", "Failed to get Prometheus rules", async () => {
    const res = await getClient().get("/api/v1/rules");
    return res.data.data.groups.map((g: GroupRecord) => ({
      name: g.name,
      file: g.file,
      rules: g.rules.map((r) => ({
        type: r.type,
        name: r.name,
        query: r.query,
        duration: r.duration,
        severity: r.labels?.severity,
        state: r.state,
        health: r.health,
      })),
    }));
  });

export const getMetadata = (input: unknown) => {
  const { metric } = z.object({ metric: z.string().optional() }).parse(input);
  return withUpstream("prometheus", "Failed to get Prometheus metadata", async () => {
    const params: Record<string, string> = {};
    if (metric) params.metric = metric;
    const res = await getClient().get("/api/v1/metadata", { params });
    return res.data.data;
  });
};

export const listMetricNames = () =>
  withUpstream("prometheus", "Failed to list Prometheus metric names", async () => {
    const res = await getClient().get("/api/v1/label/__name__/values");
    return res.data.data;
  });
