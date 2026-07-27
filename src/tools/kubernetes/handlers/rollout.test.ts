import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeRollout } from "./rollout.js";
import { subjectMatchesSa } from "./rbac.js";

test("shapeRollout: deployment maps replica fields + complete flag", () => {
  const done = shapeRollout("deployment", { metadata: { name: "api", namespace: "p" }, spec: { replicas: 3, strategy: { type: "RollingUpdate" } }, status: { updatedReplicas: 3, readyReplicas: 3, availableReplicas: 3, unavailableReplicas: 0 } });
  assert.equal(done.desired, 3);
  assert.equal(done.complete, true);
  assert.equal(done.strategy, "RollingUpdate");

  const stuck = shapeRollout("deployment", { spec: { replicas: 3 }, status: { updatedReplicas: 1, readyReplicas: 1, unavailableReplicas: 2, conditions: [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }] } });
  assert.equal(stuck.complete, false);
  assert.equal(stuck.unavailable, 2);
  assert.equal(stuck.conditions?.[0].reason, "ProgressDeadlineExceeded");
});

test("shapeRollout: daemonset reads the numberScheduled fields (not replicas)", () => {
  const ds = shapeRollout("daemonset", { metadata: { name: "node-exporter" }, status: { desiredNumberScheduled: 5, updatedNumberScheduled: 5, numberReady: 4, numberAvailable: 4, numberUnavailable: 1 } });
  assert.equal(ds.desired, 5);
  assert.equal(ds.ready, 4);
  assert.equal(ds.unavailable, 1);
  assert.equal(ds.complete, false); // 1 unavailable
});

test("subjectMatchesSa matches a ServiceAccount subject (namespace defaults to the binding ns)", () => {
  assert.equal(subjectMatchesSa([{ kind: "ServiceAccount", name: "mcp", namespace: "devops-tools" }], "mcp", "devops-tools"), true);
  assert.equal(subjectMatchesSa([{ kind: "ServiceAccount", name: "mcp" }], "mcp", "devops-tools"), true); // ns omitted → binding ns
  assert.equal(subjectMatchesSa([{ kind: "ServiceAccount", name: "other", namespace: "devops-tools" }], "mcp", "devops-tools"), false);
  assert.equal(subjectMatchesSa([{ kind: "User", name: "mcp" }], "mcp", "devops-tools"), false); // not a SA
  assert.equal(subjectMatchesSa(undefined, "mcp", "devops-tools"), false);
});
