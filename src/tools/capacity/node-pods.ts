import { z } from "zod";
import { getApi, k8s, listAll } from "../kubernetes/client.js";
import { getClient } from "../prometheus/client.js";
import { withUpstream } from "../../utils/errors/index.js";
import { parseCpu, parseMem } from "./rightsizing.js";

/**
 * "What runs on this node, and what is using it" — the first question of every node incident, and
 * one no tool answered. `k8s_list_pods` is per namespace with no node filter, `k8s_describe_node`
 * is config only, and node-exporter keys its series by `instance` (`10.10.10.13:9100`), so the
 * model would have to write `* on(instance) group_left(nodename) node_uname_info` itself to read a
 * node's memory by name. Found 2026-11-14 building the node bench cases: the node-pressure
 * playbook's "the pod that dies is rarely the pod that caused it" had no tool that could name the
 * pod that caused it.
 *
 * Joined here, like k8s_recommend_resources, and for the same reason: three model-written calls
 * are three chances to be confidently wrong about a number. The pod list is the API server's;
 * the usage is Prometheus' and best-effort — a failed query leaves its fields null and says so in
 * `usage.unavailable`, never an error and never a zero.
 *
 * Every pod on the node, not only the busy ones: QoS decides who the kubelet evicts first, and a
 * BestEffort pod using nothing is still the first victim.
 */

const NODE_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const MAX_PODS = 40;

const mi = (b: number | null | undefined) => (b === null || b === undefined ? null : `${Math.round(b / 1048576)}Mi`);
const milli = (c: number | null | undefined) => (c === null || c === undefined ? null : `${Math.round(c * 1000)}m`);
const pct = (part: number, whole: number | null) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

export interface PodLike {
  metadata?: { name?: string; namespace?: string };
  spec?: { containers?: Array<{ resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }> };
  status?: { phase?: string; qosClass?: string; containerStatuses?: Array<{ ready?: boolean; restartCount?: number }> };
}

export interface NodeUsage {
  memoryAvailable?: number | null;
  memoryTotal?: number | null;
  rootFsAvailable?: number | null;
  rootFsSize?: number | null;
  /** "namespace/pod" -> working set bytes */
  podWorkingSet?: Map<string, number>;
  unavailable?: string[];
}

const sum = (xs: Array<number | null>) => xs.reduce<number>((a, x) => a + (x ?? 0), 0);

/** exported for the test — the whole judgement of the tool */
export function buildNodePods(
  node: { name: string; allocatable?: Record<string, string> },
  pods: PodLike[],
  usage: NodeUsage
) {
  const allocCpu = parseCpu(node.allocatable?.cpu);
  const allocMem = parseMem(node.allocatable?.memory);
  const rows = pods
    .filter((p) => p.status?.phase !== "Succeeded" && p.status?.phase !== "Failed")
    .map((p) => {
      const cs = p.spec?.containers ?? [];
      const cpuReq = sum(cs.map((c) => parseCpu(c.resources?.requests?.cpu)));
      const memReq = sum(cs.map((c) => parseMem(c.resources?.requests?.memory)));
      // A container without a memory limit makes the pod's limit unbounded, not the sum of the rest.
      const memLim = cs.every((c) => parseMem(c.resources?.limits?.memory) !== null) ? sum(cs.map((c) => parseMem(c.resources?.limits?.memory))) : null;
      const key = `${p.metadata?.namespace}/${p.metadata?.name}`;
      const statuses = p.status?.containerStatuses ?? [];
      return {
        namespace: p.metadata?.namespace,
        pod: p.metadata?.name,
        qos: p.status?.qosClass,
        phase: p.status?.phase,
        ready: statuses.length > 0 && statuses.every((s) => s.ready),
        restarts: sum(statuses.map((s) => s.restartCount ?? 0)),
        cpuRequest: milli(cpuReq),
        memoryRequest: mi(memReq),
        memoryLimit: memLim === null ? "none" : mi(memLim),
        memoryWorkingSet: mi(usage.podWorkingSet?.get(key)),
        _ws: usage.podWorkingSet?.get(key) ?? -1,
        _cpu: cpuReq,
        _memReq: memReq,
        _memLim: memLim ?? 0,
      };
    });
  rows.sort((a, b) => b._ws - a._ws || b._memReq - a._memReq);

  const memUsed = usage.memoryTotal && usage.memoryAvailable !== null && usage.memoryAvailable !== undefined ? usage.memoryTotal - usage.memoryAvailable : null;
  const fsUsed = usage.rootFsSize && usage.rootFsAvailable !== null && usage.rootFsAvailable !== undefined ? usage.rootFsSize - usage.rootFsAvailable : null;
  const cpuRequests = sum(rows.map((r) => r._cpu));
  const memRequests = sum(rows.map((r) => r._memReq));
  const memLimits = sum(rows.map((r) => r._memLim));
  return {
    node: node.name,
    allocatable: { cpu: milli(allocCpu), memory: mi(allocMem) },
    // What the scheduler has promised away — what `kubectl describe node` calls "Allocated resources".
    allocated: {
      cpuRequests: milli(cpuRequests),
      cpuRequestsPct: pct(cpuRequests, allocCpu),
      memoryRequests: mi(memRequests),
      memoryRequestsPct: pct(memRequests, allocMem),
      memoryLimits: mi(memLimits),
      memoryLimitsPct: pct(memLimits, allocMem),
    },
    // What is really in use, from node-exporter — distinct from the promises above.
    usage: {
      memoryTotal: mi(usage.memoryTotal),
      memoryAvailable: mi(usage.memoryAvailable),
      memoryUsedPct: memUsed === null ? null : pct(memUsed, usage.memoryTotal!),
      rootFsSize: usage.rootFsSize ? `${(usage.rootFsSize / 1073741824).toFixed(1)}Gi` : null,
      rootFsAvailable: usage.rootFsAvailable !== null && usage.rootFsAvailable !== undefined ? `${(usage.rootFsAvailable / 1073741824).toFixed(1)}Gi` : null,
      rootFsUsedPct: fsUsed === null ? null : pct(fsUsed, usage.rootFsSize!),
      ...(usage.unavailable?.length ? { unavailable: usage.unavailable } : {}),
    },
    podsTotal: rows.length,
    // Busiest first by working set, then by memory request for pods with no sample.
    pods: rows.slice(0, MAX_PODS).map(({ _ws, _cpu, _memReq, _memLim, ...r }) => r),
    note:
      "memoryWorkingSet is live usage (cAdvisor); memoryRequest/Limit are the spec. Under MemoryPressure the kubelet evicts " +
      "BestEffort pods first, then Burstable pods using the most above their request — the victim is chosen by QoS and " +
      "overage, so the pod that died is not necessarily the one using the memory.",
  };
}

async function scalar(promql: string): Promise<number | null> {
  const res = await getClient().get("/api/v1/query", { params: { query: promql } });
  const v = Number(res.data?.data?.result?.[0]?.value?.[1]);
  return Number.isFinite(v) ? v : null;
}

async function podWorkingSet(node: string): Promise<Map<string, number>> {
  // max by container first: cAdvisor is scraped twice on some clusters (see rightsizing's usageQueries)
  const q = `sum by (namespace, pod) (max by (namespace, pod, container) (container_memory_working_set_bytes{node="${node}",container!="",container!="POD"}))`;
  const res = await getClient().get("/api/v1/query", { params: { query: q } });
  const out = new Map<string, number>();
  for (const s of res.data?.data?.result ?? []) {
    const v = Number(s.value?.[1]);
    if (s.metric?.namespace && s.metric?.pod && Number.isFinite(v)) out.set(`${s.metric.namespace}/${s.metric.pod}`, v);
  }
  return out;
}

const Input = z.object({ name: z.string().regex(NODE_RE, "a node name") });

export const nodePods = (input: unknown) => {
  const { name } = Input.parse(input);
  return withUpstream("kubernetes", `Failed to read node ${name}`, async () => {
    const core = getApi(k8s.CoreV1Api);
    const node = await core.readNode({ name });
    const pods = await listAll<PodLike>((o) => core.listPodForAllNamespaces({ ...o, fieldSelector: `spec.nodeName=${name}` }) as never);

    // node-exporter is keyed by instance; node_uname_info carries the node's name.
    const byName = (metric: string, extra = "") =>
      `max(${metric}${extra} * on(instance) group_left(nodename) node_uname_info{nodename="${name}"})`;
    const unavailable: string[] = [];
    const tryNum = (label: string, q: string) => scalar(q).catch(() => (unavailable.push(label), null));
    const [memoryAvailable, memoryTotal, rootFsAvailable, rootFsSize, podWs] = await Promise.all([
      tryNum("memoryAvailable", byName("node_memory_MemAvailable_bytes")),
      tryNum("memoryTotal", byName("node_memory_MemTotal_bytes")),
      tryNum("rootFsAvailable", byName("node_filesystem_avail_bytes", '{mountpoint="/"}')),
      tryNum("rootFsSize", byName("node_filesystem_size_bytes", '{mountpoint="/"}')),
      podWorkingSet(name).catch(() => (unavailable.push("podWorkingSet"), new Map<string, number>())),
    ]);
    if (memoryTotal === null && !unavailable.includes("memoryTotal")) unavailable.push("node-exporter has no series for this node");

    return {
      ...buildNodePods(
        { name, allocatable: (node as { status?: { allocatable?: Record<string, string> } }).status?.allocatable },
        pods.items,
        { memoryAvailable, memoryTotal, rootFsAvailable, rootFsSize, podWorkingSet: podWs, unavailable }
      ),
      ...(pods.complete ? {} : { incomplete: "the pod listing hit its ceiling — the list is partial" }),
    };
  });
};
