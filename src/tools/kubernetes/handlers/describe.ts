import { z } from "zod";
import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NS } from "../schemas.js";

// Detail ("describe"-style) readers — the depth the list tools omit. Deliberately report only
// K8s API STATE/CONFIG (container states, termination reasons, conditions, taints, requests/
// limits, capacity/allocatable). NO live CPU/memory USAGE — that's Prometheus/metrics-server's
// job, and duplicating it here would overlap. This surfaces the ground-truth "why" (OOMKilled,
// CrashLoopBackOff, MemoryPressure, no ready endpoints) that the agent otherwise has to infer.

type ContainerState = {
  running?: { startedAt?: string };
  waiting?: { reason?: string; message?: string };
  terminated?: { reason?: string; exitCode?: number; message?: string; startedAt?: string; finishedAt?: string };
};

type ContainerStatus = { name?: string; ready?: boolean; restartCount?: number; image?: string; state?: ContainerState; lastState?: ContainerState };

// One-line human summary of a container state — the crash/OOM signal lives here.
function describeState(state: ContainerState | undefined): string | undefined {
  if (!state) return undefined;
  if (state.running) return `Running (since ${state.running.startedAt})`;
  if (state.waiting) return `Waiting: ${state.waiting.reason ?? "?"}${state.waiting.message ? ` — ${state.waiting.message}` : ""}`;
  if (state.terminated) {
    const t = state.terminated;
    return `Terminated: ${t.reason ?? "?"}${t.exitCode !== undefined ? ` (exit ${t.exitCode})` : ""}${t.message ? ` — ${t.message}` : ""}`;
  }
  return undefined;
}

interface PodLike {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string };
  spec?: { nodeName?: string; containers?: Array<{ name?: string; resources?: { requests?: unknown; limits?: unknown } }> };
  status?: {
    phase?: string;
    reason?: string;
    message?: string;
    podIP?: string;
    qosClass?: string;
    startTime?: string;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    containerStatuses?: ContainerStatus[];
    initContainerStatuses?: ContainerStatus[];
  };
}

// exported for unit tests
export function shapePodDetail(pod: PodLike) {
  const shapeCs = (c: ContainerStatus) => ({
    name: c.name,
    ready: c.ready,
    restarts: c.restartCount,
    image: c.image,
    state: describeState(c.state),
    lastState: describeState(c.lastState), // previous termination — why it restarted (OOMKilled/exit code)
  });
  return {
    name: pod.metadata?.name,
    namespace: pod.metadata?.namespace,
    phase: pod.status?.phase,
    reason: pod.status?.reason, // pod-level, e.g. Evicted / NodeAffinity
    message: pod.status?.message,
    node: pod.spec?.nodeName,
    podIP: pod.status?.podIP,
    qosClass: pod.status?.qosClass,
    startTime: pod.status?.startTime,
    conditions: pod.status?.conditions?.map((c) => ({ type: c.type, status: c.status, reason: c.reason, message: c.message })),
    initContainers: pod.status?.initContainerStatuses?.map(shapeCs),
    containers: (pod.status?.containerStatuses ?? []).map(shapeCs),
    // configured requests/limits (spec) — NOT usage; QoS above is derived from these
    resources: pod.spec?.containers?.map((c) => ({ name: c.name, requests: c.resources?.requests, limits: c.resources?.limits })),
  };
}

interface EventLike {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string;
}

// exported for unit tests — like `kubectl describe`, the object's own recent events (newest first).
// Warnings (FailedScheduling, BackOff, Unhealthy, FailedMount) are usually the smoking gun.
export function shapeEvents(items: EventLike[], limit = 10) {
  return [...items]
    .sort((a, b) => new Date(b.lastTimestamp ?? 0).getTime() - new Date(a.lastTimestamp ?? 0).getTime())
    .slice(0, limit)
    .map((e) => ({ type: e.type, reason: e.reason, message: e.message, count: e.count, lastTime: e.lastTimestamp }));
}

export const describePod = (input: unknown) => {
  const { namespace, pod_name } = NS.extend({ pod_name: z.string().min(1) }).parse(input);
  return withUpstream("kubernetes", `Failed to describe pod ${namespace}/${pod_name}`, async () => {
    const api = getApi(k8s.CoreV1Api);
    const pod = await api.readNamespacedPod({ name: pod_name, namespace });
    // the pod's own events — best-effort so a missing events RBAC never fails the describe
    const events = await api
      .listNamespacedEvent({ namespace, fieldSelector: `involvedObject.name=${pod_name},involvedObject.kind=Pod` })
      .then((r) => r.items as EventLike[])
      .catch(() => [] as EventLike[]);
    return { ...shapePodDetail(pod as PodLike), recentEvents: shapeEvents(events) };
  });
};

interface NodeLike {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { unschedulable?: boolean; taints?: Array<{ key?: string; value?: string; effect?: string }> };
  status?: {
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
    capacity?: unknown;
    allocatable?: unknown;
    nodeInfo?: { kubeletVersion?: string; osImage?: string; kernelVersion?: string };
  };
}

export function shapeNodeDetail(node: NodeLike) {
  return {
    name: node.metadata?.name,
    // Ready + the pressure conditions (MemoryPressure/DiskPressure/PIDPressure) — scheduling signals
    conditions: node.status?.conditions?.map((c) => ({ type: c.type, status: c.status, reason: c.reason, message: c.message })),
    unschedulable: node.spec?.unschedulable ?? false,
    taints: node.spec?.taints?.map((t) => `${t.key}=${t.value ?? ""}:${t.effect}`),
    capacity: node.status?.capacity, // total resources (config, not usage)
    allocatable: node.status?.allocatable, // schedulable total (config, not usage)
    kubeletVersion: node.status?.nodeInfo?.kubeletVersion,
    os: node.status?.nodeInfo?.osImage,
    kernel: node.status?.nodeInfo?.kernelVersion,
    roles: Object.keys(node.metadata?.labels ?? {})
      .filter((l) => l.startsWith("node-role.kubernetes.io/"))
      .map((l) => l.replace("node-role.kubernetes.io/", "")),
  };
}

export const describeNode = (input: unknown) => {
  const { name } = z.object({ name: z.string().min(1) }).parse(input);
  return withUpstream("kubernetes", `Failed to describe node ${name}`, async () => {
    const node = await getApi(k8s.CoreV1Api).readNode({ name });
    return shapeNodeDetail(node as NodeLike);
  });
};

interface EndpointsLike {
  metadata?: { name?: string; namespace?: string };
  subsets?: Array<{
    addresses?: Array<{ ip?: string; nodeName?: string; targetRef?: { name?: string } }>;
    notReadyAddresses?: Array<{ ip?: string; targetRef?: { name?: string } }>;
    ports?: Array<{ name?: string; port?: number; protocol?: string }>;
  }>;
}

export function shapeEndpoints(ep: EndpointsLike) {
  const subsets = ep.subsets ?? [];
  const ready = subsets.flatMap((s) => (s.addresses ?? []).map((a) => ({ ip: a.ip, target: a.targetRef?.name, node: a.nodeName })));
  const notReady = subsets.flatMap((s) => (s.notReadyAddresses ?? []).map((a) => ({ ip: a.ip, target: a.targetRef?.name })));
  const ports = subsets.flatMap((s) => (s.ports ?? []).map((p) => `${p.name ?? ""}:${p.port}/${p.protocol ?? "TCP"}`));
  return {
    service: ep.metadata?.name,
    namespace: ep.metadata?.namespace,
    readyCount: ready.length, // 0 → the service has no backends → 503 / connection refused
    notReadyCount: notReady.length,
    ready,
    notReady,
    ports: [...new Set(ports)],
  };
}

export const getEndpoints = (input: unknown) => {
  const { namespace, service } = NS.extend({ service: z.string().min(1) }).parse(input);
  return withUpstream("kubernetes", `Failed to get endpoints for service ${namespace}/${service}`, async () => {
    // classic Endpoints share the Service's name; one object answers "ready backends?"
    const ep = await getApi(k8s.CoreV1Api).readNamespacedEndpoints({ name: service, namespace });
    return shapeEndpoints(ep as EndpointsLike);
  });
};
