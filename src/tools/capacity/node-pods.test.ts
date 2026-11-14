import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNodePods, type PodLike } from "./node-pods.js";

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
