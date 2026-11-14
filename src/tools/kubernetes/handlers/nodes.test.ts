import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeNodeRow } from "./nodes.js";

// Bench A16, 2026-11-14: a cordoned node listed as nothing but `status: "True"`.
test("a cordoned node says so in the listing, with the kubelet's taint as-is", () => {
  const row = shapeNodeRow({
    metadata: { name: "worker3-vm", labels: {} },
    spec: { unschedulable: true, taints: [{ key: "node.kubernetes.io/unschedulable", effect: "NoSchedule" }] },
    status: { conditions: [{ type: "Ready", status: "True" }, { type: "MemoryPressure", status: "False" }] },
  });
  assert.equal(row.status, "True");
  assert.equal(row.unschedulable, true);
  assert.deepEqual(row.taints, ["node.kubernetes.io/unschedulable:NoSchedule"]);
  assert.deepEqual(row.pressure, []);
});

test("pressure lists only the conditions that are true; a healthy node is false and empty, not absent", () => {
  const healthy = shapeNodeRow({ metadata: { name: "a" }, status: { conditions: [{ type: "Ready", status: "True" }, { type: "DiskPressure", status: "False" }] } });
  assert.equal(healthy.unschedulable, false);
  assert.deepEqual(healthy.taints, []);
  assert.deepEqual(healthy.pressure, []);
  const pressed = shapeNodeRow({
    metadata: { name: "b", labels: { "node-role.kubernetes.io/control-plane": "" } },
    spec: { taints: [{ key: "dedicated", value: "gpu", effect: "NoExecute" }] },
    status: { conditions: [{ type: "Ready", status: "False" }, { type: "MemoryPressure", status: "True" }, { type: "PIDPressure", status: "True" }] },
  });
  assert.equal(pressed.status, "False");
  assert.deepEqual(pressed.pressure, ["MemoryPressure", "PIDPressure"]);
  assert.deepEqual(pressed.taints, ["dedicated=gpu:NoExecute"]);
  assert.deepEqual(pressed.roles, ["control-plane"]);
});
