import { z } from "zod";
import { getClient } from "./client.js";
import { withUpstream } from "../../utils/errors/index.js";

// Alertmanager is the single source of truth for "what is firing right now". Prometheus
// /api/v1/alerts only sees rules Prometheus itself evaluates, so the moment a second
// evaluator exists (Loki Ruler, Kibana Alerting) that endpoint becomes a silently partial
// view — it would answer "nothing else is firing" while a log-based alert is paging. Every
// evaluator pushes here, and only here are silences and inhibition known.
//
// Alerts that are still `pending` in an evaluator are deliberately invisible: the `for:`
// window hasn't elapsed, so nothing has been routed. This tool reports what Alertmanager
// holds, not what might arrive.

// Detail is capped, counts are not. The summary is computed over the COMPLETE set so
// "nothing else is firing" can never be an artefact of truncation — the same lesson as
// k8s_cluster_health, where a cap turned a partial answer into one that read as complete.
// A capped response says how many alerts it left out of the detail.
export const MAX_DETAIL_ALERTS = 60;

type AmStatus = { state?: unknown; silencedBy?: unknown; inhibitedBy?: unknown };
type AmAlert = {
  labels?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  startsAt?: unknown;
  fingerprint?: unknown;
  status?: AmStatus;
};
type AmGroup = { labels?: Record<string, unknown>; receiver?: { name?: unknown }; alerts?: unknown };

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Suppression is reported as a LABEL, never as a filter. A silenced alert is still firing —
 * on-call muted the notification, not the problem — so dropping it here would let the agent
 * report "nothing else is wrong" about a condition a human deliberately muted, and would let
 * post-remediation verification score a silenced alert as recovered.
 *
 * `suppressed` is Alertmanager's own umbrella state; the two arrays say which kind, so they
 * decide first. Anything else (`active`, `unprocessed`, or a state a future version adds) is
 * passed through verbatim rather than guessed at.
 */
export function alertStatus(s: AmStatus | undefined): string {
  if (ids(s?.silencedBy).length) return "silenced";
  if (ids(s?.inhibitedBy).length) return "inhibited";
  return str(s?.state) ?? "unknown";
}

function shapeAlert(a: AmAlert) {
  const labels = (a.labels ?? {}) as Record<string, unknown>;
  const annotations = (a.annotations ?? {}) as Record<string, unknown>;
  const status = alertStatus(a.status);
  const silencedBy = ids(a.status?.silencedBy);
  return {
    name: str(labels.alertname),
    status,
    severity: str(labels.severity),
    summary: str(annotations.summary) ?? str(annotations.description),
    startsAt: str(a.startsAt),
    labels,
    fingerprint: str(a.fingerprint),
    // only when it explains the status — the silence id is what a human looks up to lift it
    ...(status === "silenced" && silencedBy.length ? { silencedBy } : {}),
  };
}

type ShapedGroup = { groupLabels: Record<string, unknown>; receiver?: string; alerts: ReturnType<typeof shapeAlert>[] };

export type ShapedAlerts = {
  summary: {
    groups: number;
    alerts: number;
    byStatus: Record<string, number>;
    bySeverity: Record<string, number>;
  };
  groups: ShapedGroup[];
  omitted?: number;
};

/**
 * /api/v2/alerts/groups → the shape the agent already reasons in. Grouping is kept because
 * it IS Alertmanager's own correlation — the same grouping the webhook delivers, so a group
 * here lines up with an incident thread rather than having to be re-derived.
 */
export function shapeGroups(raw: unknown, maxDetail = MAX_DETAIL_ALERTS): ShapedAlerts {
  const groups = (Array.isArray(raw) ? raw : []).filter((g): g is AmGroup => !!g && typeof g === "object");
  const byStatus: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const seen = new Set<string>();
  let occurrences = 0;

  // Counts run over every group before anything is capped. Dedup by fingerprint: one alert
  // routed to two receivers appears in two groups, and counting it twice would inflate the
  // blast radius the agent reports.
  for (const g of groups) {
    for (const a of alertsOf(g)) {
      occurrences++;
      const id = str(a.fingerprint) ?? JSON.stringify(a.labels ?? {});
      if (seen.has(id)) continue;
      seen.add(id);
      const st = alertStatus(a.status);
      byStatus[st] = (byStatus[st] ?? 0) + 1;
      const sev = str(a.labels?.severity) ?? "none";
      bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
    }
  }

  let budget = maxDetail;
  const shaped: ShapedGroup[] = [];
  for (const g of groups) {
    if (budget <= 0) break;
    const take = alertsOf(g).slice(0, budget);
    budget -= take.length;
    shaped.push({
      groupLabels: (g.labels ?? {}) as Record<string, unknown>,
      receiver: str(g.receiver?.name),
      alerts: take.map(shapeAlert),
    });
  }

  const shown = shaped.reduce((n, g) => n + g.alerts.length, 0);
  return {
    summary: { groups: groups.length, alerts: seen.size, byStatus, bySeverity },
    groups: shaped,
    ...(occurrences > shown ? { omitted: occurrences - shown } : {}),
  };
}

const alertsOf = (g: AmGroup): AmAlert[] =>
  Array.isArray(g?.alerts) ? (g.alerts as unknown[]).filter((a): a is AmAlert => !!a && typeof a === "object") : [];

export const getAlerts = (input: unknown) => {
  const { filter } = z.object({ filter: z.array(z.string()).optional() }).parse(input ?? {});
  return withUpstream("alertmanager", "Failed to get Alertmanager alerts", async () => {
    // Explicit rather than relying on the server's defaults: suppressed alerts must come
    // back so `alertStatus` can label them. URLSearchParams because Alertmanager wants
    // `filter` repeated, and axios would serialize an array as `filter[]=`.
    const params = new URLSearchParams({ active: "true", silenced: "true", inhibited: "true" });
    for (const f of filter ?? []) params.append("filter", f);
    const res = await getClient().get("/api/v2/alerts/groups", { params });
    return shapeGroups(res.data);
  });
};
