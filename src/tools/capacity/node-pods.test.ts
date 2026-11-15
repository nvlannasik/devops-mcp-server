import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNodePods, evictedOf, type PodLike } from "./node-pods.js";

const MiB = 1048576;
const pod = (ns: string, name: string, over: { qos?: string; req?: string; lim?: string; cpu?: string; phase?: string; restarts?: number } = {}): PodLike => ({
  metadata: { namespace: ns, name },
  spec: { containers: [{ resources: { requests: { ...(over.req ? { memory: over.req } : {}), ...(over.cpu ? { cpu: over.cpu } : {}) }, limits: over.lim ? { memory: over.lim } : {} } }] },
  status: { phase: over.phase ?? "Running", qosClass: over.qos ?? "Burstable", containerStatuses: [{ ready: true, restartCount: over.restarts ?? 0 }] },
});
const node = { name: "worker3-vm", allocatable: { cpu: "2", memory: "1900Mi" } };

test("pods are ordered by live working set, and the hog is named even when its request is small", () => {
  const out = buildNodePods(node, [pod("kube-system", "calico-node-x", { req: "100Mi" }), pod("bench", "hog-1", { req: "64Mi", lim: "512Mi" }), pod("app", "idle", { qos: "BestEffort" })], {
    memoryTotal: 1968 * MiB, memoryAvailable: 800 * MiB,
    podWorkingSet: new Map([["kube-system/calico-node-x", 139 * MiB], ["bench/hog-1", 310 * MiB]]),
  });
  assert.deepEqual(out.pods.map((p) => p.pod), ["hog-1", "calico-node-x", "idle"]);
  assert.equal(out.pods[0].memoryWorkingSet, "310Mi");
  assert.equal(out.pods[0].memoryRequest, "64Mi");
  // BestEffort with no sample keeps its place in the list — it is the first eviction victim
  assert.equal(out.pods[2].qos, "BestEffort");
  assert.equal(out.pods[2].memoryWorkingSet, null);
  assert.equal(out.pods[2].memoryLimit, "none");
  assert.equal(out.usage.memoryUsedPct, 59.3);
});

test("allocated is what the scheduler promised; usage is what is used; finished pods count for neither", () => {
  const out = buildNodePods(node, [pod("a", "x", { req: "950Mi", cpu: "500m", lim: "1900Mi" }), pod("a", "done", { req: "900Mi", phase: "Succeeded" })], {});
  assert.equal(out.podsTotal, 1);
  assert.deepEqual(out.allocated, { cpuRequests: "500m", cpuRequestsPct: 25, memoryRequests: "950Mi", memoryRequestsPct: 50, memoryLimits: "1900Mi", memoryLimitsPct: 100 });
});

test("a failed usage read is null and named, never zero", () => {
  const out = buildNodePods(node, [pod("a", "x")], { unavailable: ["memoryTotal", "podWorkingSet"] });
  assert.equal(out.usage.memoryTotal, null);
  assert.equal(out.usage.memoryUsedPct, null);
  assert.deepEqual(out.usage.unavailable, ["memoryTotal", "podWorkingSet"]);
  assert.equal(out.pods[0].memoryWorkingSet, null);
});

// Production, 2026-11-14: master3-vm under MemoryPressure, and the RCA could not name the victims.
test("evicted pods are listed newest first with the kubelet's message, and stay out of the live pod list", () => {
  const evicted = (name: string, at: string, msg: string): PodLike => ({
    metadata: { namespace: "monitoring", name },
    status: { phase: "Failed", reason: "Evicted", qosClass: "BestEffort", message: msg, conditions: [{ type: "DisruptionTarget", reason: "TerminationByKubelet", lastTransitionTime: at }] },
  });
  const pods = [
    pod("kube-system", "kube-apiserver-master3-vm", { req: "250Mi" }),
    evicted("node-exporter-fnr5x", "2026-11-15T02:03:26Z", "The node was low on resource: memory. Container node-exporter was using 23356Ki, request is 0"),
    evicted("speaker-vt4p2", "2026-11-15T02:05:22Z", "The node was low on resource: memory. Container speaker was using 10860Ki, request is 0"),
    { metadata: { namespace: "a", name: "crashed" }, status: { phase: "Failed", reason: "Error" } },
  ];
  const out = buildNodePods(node, pods, {});
  assert.deepEqual(out.pods.map((p) => p.pod), ["kube-apiserver-master3-vm"]);
  assert.deepEqual(out.evicted.map((e) => e.pod), ["speaker-vt4p2", "node-exporter-fnr5x"]);
  assert.match(out.evicted[0].message, /low on resource: memory/);
  assert.equal(out.evicted[0].qos, "BestEffort");
  assert.deepEqual(evictedOf([pod("a", "fine")]), []);
});
