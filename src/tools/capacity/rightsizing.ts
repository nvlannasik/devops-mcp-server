import { z } from "zod";
import { getApi, k8s, listAll } from "../kubernetes/client.js";
import { blankToUndefined } from "../kubernetes/schemas.js";
import { getClient } from "../prometheus/client.js";
import { withUpstream } from "../../utils/errors/index.js";

/**
 * The other half of the capacity question: not "who is unused" but "who is sized wrong".
 *
 * This is the one tool in the server that joins two upstreams — the declared requests/limits
 * come from the API server, the observed usage from Prometheus — and it does the join HERE
 * rather than leaving it to the model. Asking a small model to write a correct
 * `quantile_over_time` subquery, parse `512Mi`, and map `orders-api-7c9d4-x2k` back to its
 * Deployment across three tool calls is three chances to be confidently wrong about a number
 * that ends up in an RCA.
 */

// Kubernetes quantity -> cores. "100m" = 0.1, "1500m" = 1.5, "2" = 2.
export function parseCpu(q?: string): number | null {
  if (!q) return null;
  const m = /^(\d+(?:\.\d+)?)(m|u|n)?$/.exec(q.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "m" ? n / 1e3 : m[2] === "u" ? n / 1e6 : m[2] === "n" ? n / 1e9 : n;
}

const MEM_UNITS: Record<string, number> = {
  "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
};

// Kubernetes quantity -> bytes. "512Mi", "1Gi", "500M", "1073741824".
export function parseMem(q?: string): number | null {
  if (!q) return null;
  const m = /^(\d+(?:\.\d+)?)([EPTGMk]i?)?$/.exec(q.trim());
  if (!m) return null;
  const unit = MEM_UNITS[m[2] ?? ""];
  return unit === undefined ? null : Number(m[1]) * unit;
}

// Always millicores / always MiB: one unit per dimension is one less thing for the model to
// convert, and a converted number is a number that can come out wrong in Slack.
// The epsilon is not cosmetic: 1 - 0.1*1.15 lands on 0.8850000000000001 in float, and a bare
// ceil() turns that into 886m — an off-by-one that reads as a real difference in a diff.
const EPS = 1e-9;
const fmtCpu = (cores: number) => `${Math.max(10, Math.ceil(cores * 1000 - EPS))}m`;
const fmtMem = (bytes: number) => `${Math.max(32, Math.ceil(bytes / 1024 / 1024 - EPS))}Mi`;

export interface WorkloadContainer {
  kind: string;
  namespace: string;
  workload: string;
  container: string;
  replicas: number;
  cpuRequest: number | null;
  memRequest: number | null;
  cpuLimit: number | null;
  memLimit: number | null;
}

export interface Usage {
  cpuCores?: number;
  memBytes?: number;
  throttleRatio?: number;
}

const ckey = (c: { namespace: string; kind: string; workload: string; container: string }) =>
  `${c.namespace}/${c.kind}/${c.workload}/${c.container}`;

/**
 * Pod name -> owning workload by longest name prefix: `orders-api-7c9d4-x2k` belongs to
 * `orders-api`, not to `orders` — hence longest-wins rather than first-match. Deliberately not
 * an ownerReferences walk (pod -> ReplicaSet -> Deployment): that is one extra API list and one
 * extra hop per pod to resolve a name the naming convention already encodes.
 *
 * exported for the test
 */
export function aggregateUsage(
  containers: WorkloadContainer[],
  metrics: { cpu: Map<string, number>; mem: Map<string, number>; throttle: Map<string, number> }
): Map<string, Usage> {
  const namesByNs = new Map<string, string[]>();
  for (const c of containers) {
    const list = namesByNs.get(c.namespace) ?? [];
    if (!list.includes(c.workload)) list.push(c.workload);
    namesByNs.set(c.namespace, list);
  }
  for (const list of namesByNs.values()) list.sort((a, b) => b.length - a.length);

  const owners = new Set(containers.map(ckey));
  const byKind = new Map<string, string[]>(); // "ns/workload" -> kinds (a name can be reused)
  for (const c of containers) {
    const k = `${c.namespace}/${c.workload}`;
    const list = byKind.get(k) ?? [];
    if (!list.includes(c.kind)) list.push(c.kind);
    byKind.set(k, list);
  }

  const out = new Map<string, Usage>();
  const merge = (series: string, field: keyof Usage, value: number) => {
    const [namespace, pod, container] = series.split("/");
    const workload = (namesByNs.get(namespace) ?? []).find((n) => pod === n || pod.startsWith(`${n}-`));
    if (!workload) return;
    for (const kind of byKind.get(`${namespace}/${workload}`) ?? []) {
      const k = ckey({ namespace, kind, workload, container });
      if (!owners.has(k)) continue;
      const cur = out.get(k) ?? {};
      // max across replicas: sizing a container for its busiest pod is the only safe direction.
      cur[field] = Math.max(cur[field] ?? 0, value);
      out.set(k, cur);
    }
  };

  for (const [s, v] of metrics.cpu) merge(s, "cpuCores", v);
  for (const [s, v] of metrics.mem) merge(s, "memBytes", v);
  for (const [s, v] of metrics.throttle) merge(s, "throttleRatio", v);
  return out;
}

const CPU_HEADROOM = 1.15;
const MEM_HEADROOM = 1.2;
const MEM_LIMIT_HEADROOM = 1.5;
const OVERPROVISION_FACTOR = 2; // reserving more than 2x the observed peak is worth a line
const THROTTLE_ALERT = 0.05;
const OOM_MARGIN = 0.9;

// Flags in the order an on-call cares about them. A container that is BOTH throttled and
// over-provisioned on memory sorts by its worst flag, not its first.
const FLAG_RANK = [
  "oom_risk",
  "cpu_throttled",
  "memory_under_provisioned",
  "cpu_under_provisioned",
  "no_requests",
  "over_provisioned",
  "no_data",
];

export interface Recommendation {
  kind: string;
  namespace: string;
  workload: string;
  container: string;
  replicas: number;
  flags: string[];
  current: Record<string, string | null>;
  observed: Record<string, string | number | null>;
  recommended?: Record<string, string>;
  savings?: { cpuCores: number; memoryBytes: number };
}

const MAX_RECOMMENDATIONS = 40;

/** exported for the test — this is the whole judgement of the tool */
export function buildRecommendations(containers: WorkloadContainer[], usage: Map<string, Usage>) {
  const items: Recommendation[] = [];
  let withData = 0;

  for (const c of containers) {
    const u = usage.get(ckey(c)) ?? {};
    const flags: string[] = [];
    const current = {
      cpuRequest: c.cpuRequest === null ? null : fmtCpu(c.cpuRequest),
      memoryRequest: c.memRequest === null ? null : fmtMem(c.memRequest),
      cpuLimit: c.cpuLimit === null ? null : fmtCpu(c.cpuLimit),
      memoryLimit: c.memLimit === null ? null : fmtMem(c.memLimit),
    };

    if (c.cpuRequest === null && c.memRequest === null) flags.push("no_requests");

    const hasData = u.cpuCores !== undefined || u.memBytes !== undefined;
    if (!hasData) {
      items.push({
        kind: c.kind, namespace: c.namespace, workload: c.workload, container: c.container,
        replicas: c.replicas,
        flags: [...flags, "no_data"],
        current,
        observed: { note: "no cadvisor samples in the window — scaled to zero, created after the window started, or not scraped" },
      });
      continue;
    }
    withData++;

    const cpu = u.cpuCores ?? 0;
    const mem = u.memBytes ?? 0;
    const throttle = u.throttleRatio ?? 0;

    if (throttle > THROTTLE_ALERT && c.cpuLimit !== null) flags.push("cpu_throttled");
    if (c.memLimit !== null && mem > c.memLimit * OOM_MARGIN) flags.push("oom_risk");
    if (c.cpuRequest !== null && cpu > c.cpuRequest) flags.push("cpu_under_provisioned");
    if (c.memRequest !== null && mem > c.memRequest) flags.push("memory_under_provisioned");
    if (
      (c.cpuRequest !== null && cpu > 0 && c.cpuRequest > cpu * OVERPROVISION_FACTOR) ||
      (c.memRequest !== null && mem > 0 && c.memRequest > mem * OVERPROVISION_FACTOR)
    ) {
      flags.push("over_provisioned");
    }

    const cpuReq = cpu * CPU_HEADROOM;
    const memReq = mem * MEM_HEADROOM;
    const memLim = mem * MEM_LIMIT_HEADROOM;
    const recommended: Record<string, string> = {
      cpuRequest: fmtCpu(cpuReq),
      memoryRequest: fmtMem(memReq),
      memoryLimit: fmtMem(memLim),
    };
    // A CPU limit is only recommended where one already exists — adding one to a container that
    // runs without it introduces throttling that was never there, which is a regression dressed
    // up as a recommendation. Raising an existing limit that IS throttling is the safe half.
    if (c.cpuLimit !== null) {
      recommended.cpuLimit = fmtCpu(Math.max(c.cpuLimit, cpu * 2));
    }

    const savings = {
      cpuCores: Math.max(0, ((c.cpuRequest ?? 0) - cpuReq) * c.replicas),
      memoryBytes: Math.max(0, ((c.memRequest ?? 0) - memReq) * c.replicas),
    };

    items.push({
      kind: c.kind, namespace: c.namespace, workload: c.workload, container: c.container,
      replicas: c.replicas,
      flags: flags.length ? flags : ["ok"],
      current,
      observed: {
        cpuP95: fmtCpu(cpu),
        memoryPeak: fmtMem(mem),
        cpuThrottlePct: Math.round(throttle * 1000) / 10,
      },
      recommended,
      savings,
    });
  }

  const rank = (r: Recommendation) =>
    Math.min(...r.flags.map((f) => (FLAG_RANK.indexOf(f) < 0 ? FLAG_RANK.length : FLAG_RANK.indexOf(f))));
  items.sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return (b.savings?.cpuCores ?? 0) - (a.savings?.cpuCores ?? 0);
  });

  const total = items.reduce(
    (acc, i) => ({
      cpuCores: acc.cpuCores + (i.savings?.cpuCores ?? 0),
      memoryBytes: acc.memoryBytes + (i.savings?.memoryBytes ?? 0),
    }),
    { cpuCores: 0, memoryBytes: 0 }
  );

  return {
    scanned: { containers: containers.length, withMetrics: withData },
    potentialRequestSavings: {
      cpu: fmtCpu(total.cpuCores),
      memory: fmtMem(total.memoryBytes),
    },
    recommendationsTotal: items.length,
    recommendations: items.slice(0, MAX_RECOMMENDATIONS),
  };
}

const NS_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// Also the guard that keeps caller input out of the PromQL string below.
const WINDOW_RE = /^\d+[mhd]$/;

const RecommendInput = z.object({
  namespace: blankToUndefined(z.string().regex(NS_RE).optional()),
  workload: blankToUndefined(z.string().regex(NS_RE).optional()),
  window: blankToUndefined(z.string().regex(WINDOW_RE).default("24h")),
});

async function vector(promql: string): Promise<Map<string, number>> {
  const res = await getClient().get("/api/v1/query", { params: { query: promql } });
  const out = new Map<string, number>();
  for (const s of res.data?.data?.result ?? []) {
    const { namespace, pod, container } = s.metric ?? {};
    const v = Number(s.value?.[1]);
    if (!namespace || !pod || !container || !Number.isFinite(v)) continue;
    out.set(`${namespace}/${pod}/${container}`, v);
  }
  return out;
}

const res = (r: { requests?: Record<string, string>; limits?: Record<string, string> } | undefined) => ({
  cpuRequest: parseCpu(r?.requests?.cpu),
  memRequest: parseMem(r?.requests?.memory),
  cpuLimit: parseCpu(r?.limits?.cpu),
  memLimit: parseMem(r?.limits?.memory),
});

export const recommendResources = (input: unknown) => {
  const { namespace, workload, window } = RecommendInput.parse(input);

  return withUpstream("prometheus", "Failed to build resource recommendations", async () => {
    const apps = getApi(k8s.AppsV1Api);
    const [deploys, sets, daemons] = await Promise.all([
      listAll((o) => apps.listDeploymentForAllNamespaces(o)),
      listAll((o) => apps.listStatefulSetForAllNamespaces(o)),
      listAll((o) => apps.listDaemonSetForAllNamespaces(o)),
    ]);

    const inScope = (ns?: string, name?: string) =>
      !!ns &&
      (namespace ? ns === namespace : !ns.startsWith("kube-")) &&
      (!workload || name === workload);

    const containers: WorkloadContainer[] = [];
    const collect = (
      items: Array<{ metadata?: { name?: string; namespace?: string }; spec?: unknown; status?: unknown }>,
      kind: string,
      replicasOf: (i: never) => number
    ) => {
      for (const i of items) {
        const ns = i.metadata?.namespace;
        const name = i.metadata?.name;
        if (!inScope(ns, name)) continue;
        const spec = i.spec as { template?: { spec?: { containers?: Array<{ name?: string; resources?: never }> } } };
        for (const c of spec?.template?.spec?.containers ?? []) {
          if (!c.name) continue;
          containers.push({
            kind,
            namespace: ns!,
            workload: name!,
            container: c.name,
            replicas: replicasOf(i as never),
            ...res(c.resources),
          });
        }
      }
    };
    collect(deploys.items, "Deployment", (d: { spec?: { replicas?: number } }) => d.spec?.replicas ?? 0);
    collect(sets.items, "StatefulSet", (s: { spec?: { replicas?: number } }) => s.spec?.replicas ?? 0);
    collect(daemons.items, "DaemonSet", (d: { status?: { desiredNumberScheduled?: number } }) => d.status?.desiredNumberScheduled ?? 0);

    if (!containers.length) {
      return {
        window,
        scanned: { containers: 0, withMetrics: 0 },
        recommendations: [],
        note: `No Deployment/StatefulSet/DaemonSet container matched${namespace ? ` namespace "${namespace}"` : ""}${workload ? ` workload "${workload}"` : ""}.`,
      };
    }

    // `container!="POD"` drops the pause container, `container!=""` the pod-level rollup — both
    // would otherwise land in the join as a phantom container and skew the peak.
    const sel = ['container!=""', 'container!="POD"'];
    if (namespace) sel.push(`namespace="${namespace}"`);
    const s = sel.join(",");

    // A p95 over a subquery is the expensive query in this server. It is one instant query for
    // the whole scope rather than one per workload, which is what keeps it affordable; a
    // multi-day `window` on a large cluster will still be slow.
    const [cpu, mem, throttle] = await Promise.all([
      vector(`quantile_over_time(0.95, sum by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{${s}}[5m]))[${window}:5m])`),
      vector(`max by (namespace, pod, container) (max_over_time(container_memory_working_set_bytes{${s}}[${window}]))`),
      vector(
        `sum by (namespace, pod, container) (rate(container_cpu_cfs_throttled_periods_total{${s}}[${window}])) ` +
          `/ sum by (namespace, pod, container) (rate(container_cpu_cfs_periods_total{${s}}[${window}]) > 0)`
      ),
    ]);

    const built = buildRecommendations(containers, aggregateUsage(containers, { cpu, mem, throttle }));

    return {
      window,
      ...built,
      method:
        `CPU request = p95 of a 5m rate over ${window}, x${CPU_HEADROOM}. Memory request = peak working set x${MEM_HEADROOM}, ` +
        `memory limit = peak x${MEM_LIMIT_HEADROOM}. Per container, taking the busiest replica. ` +
        `This is a percentile heuristic, NOT VPA: it has no seasonality model, so a workload whose real peak ` +
        `falls outside ${window} will be sized too small — widen \`window\` before acting on a surprisingly low number. ` +
        `A CPU limit is only ever raised, never introduced.` +
        (built.scanned.withMetrics === 0
          ? ` WARNING: not one container had metrics — cadvisor (container_cpu_usage_seconds_total) is probably not being scraped, so every number here is absent, not zero.`
          : ""),
    };
  });
};
