import { test } from "node:test";
import assert from "node:assert/strict";
import { shapePodDetail, shapeNodeDetail, shapeEndpoints, shapeEvents } from "./describe.js";

test("shapePodDetail surfaces the termination reason + exit code (the OOM/crash signal)", () => {
  const d = shapePodDetail({
    metadata: { name: "api-abc", namespace: "payment" },
    spec: { nodeName: "worker1", containers: [{ name: "api", resources: { limits: { memory: "512Mi" } } }] },
    status: {
      phase: "Running",
      qosClass: "Burstable",
      containerStatuses: [
        {
          name: "api",
          ready: false,
          restartCount: 5,
          image: "repo/api:v1",
          state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 5m0s" } },
          lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } },
        },
      ],
    },
  });
  assert.equal(d.containers[0].state, "Waiting: CrashLoopBackOff — back-off 5m0s");
  assert.equal(d.containers[0].lastState, "Terminated: OOMKilled (exit 137)");
  assert.equal(d.containers[0].restarts, 5);
  assert.equal(d.qosClass, "Burstable");
  assert.deepEqual(d.resources, [{ name: "api", requests: undefined, limits: { memory: "512Mi" } }]); // config, not usage
});

test("shapeNodeDetail reports conditions + taints, no usage", () => {
  const d = shapeNodeDetail({
    metadata: { name: "worker2", labels: { "node-role.kubernetes.io/worker": "" } },
    spec: { unschedulable: true, taints: [{ key: "node.kubernetes.io/memory-pressure", effect: "NoSchedule" }] },
    status: {
      conditions: [
        { type: "Ready", status: "True" },
        { type: "MemoryPressure", status: "True", reason: "KubeletHasInsufficientMemory" },
      ],
      capacity: { memory: "16Gi" },
      allocatable: { memory: "15Gi" },
      nodeInfo: { kubeletVersion: "v1.30.2" },
    },
  });
  assert.equal(d.unschedulable, true);
  assert.deepEqual(d.taints, ["node.kubernetes.io/memory-pressure=:NoSchedule"]);
  assert.equal(d.conditions?.find((c) => c.type === "MemoryPressure")?.status, "True");
  assert.deepEqual(d.roles, ["worker"]);
  assert.equal(d.kubeletVersion, "v1.30.2");
});

test("shapeEndpoints counts ready vs not-ready backends (readyCount=0 → 503 cause)", () => {
  const d = shapeEndpoints({
    metadata: { name: "auth-api", namespace: "dev-auth" },
    subsets: [
      {
        addresses: [{ ip: "10.1.1.5", targetRef: { name: "auth-api-1" }, nodeName: "w1" }],
        notReadyAddresses: [{ ip: "10.1.1.6", targetRef: { name: "auth-api-2" } }],
        ports: [{ name: "http", port: 8080, protocol: "TCP" }],
      },
    ],
  });
  assert.equal(d.readyCount, 1);
  assert.equal(d.notReadyCount, 1);
  assert.deepEqual(d.ports, ["http:8080/TCP"]);

  const dead = shapeEndpoints({ metadata: { name: "x" }, subsets: [] });
  assert.equal(dead.readyCount, 0); // no backends
});

test("shapeEvents returns newest-first and caps the count", () => {
  const evts = shapeEvents(
    [
      { type: "Normal", reason: "Scheduled", lastTimestamp: "2026-07-25T10:00:00Z" },
      { type: "Warning", reason: "BackOff", message: "Back-off restarting", count: 9, lastTimestamp: "2026-07-25T10:05:00Z" },
      { type: "Warning", reason: "Unhealthy", lastTimestamp: "2026-07-25T10:02:00Z" },
    ],
    2,
  );
  assert.equal(evts.length, 2); // capped
  assert.equal(evts[0].reason, "BackOff"); // newest first
  assert.equal(evts[0].count, 9);
  assert.equal(evts[1].reason, "Unhealthy");
});
