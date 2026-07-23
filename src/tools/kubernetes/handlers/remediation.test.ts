import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResourcesPatch, findContainer, findRecreatingOwner, resourceChanges } from "./remediation.js";

test("resourceChanges maps provided fields to {field,from,to}, from current or (unset)", () => {
  const cur = { requests: { cpu: "100m" }, limits: { memory: "512Mi" } };
  const changes = resourceChanges(cur, { cpu_request: "250m", memory_limit: "1Gi", cpu_limit: "1" });
  assert.deepEqual(changes, [
    { field: "requests.cpu", from: "100m", to: "250m" },
    { field: "limits.cpu", from: "(unset)", to: "1" },
    { field: "limits.memory", from: "512Mi", to: "1Gi" },
  ]);
  assert.deepEqual(resourceChanges(undefined, { memory_request: "256Mi" }), [{ field: "requests.memory", from: "(unset)", to: "256Mi" }]);
});

const workload = (...names: string[]) => ({
  spec: { template: { spec: { containers: names.map((name) => ({ name, image: `${name}:v1` })) } } },
});

test("findContainer auto-resolves when container omitted and workload has one container", () => {
  assert.equal(findContainer(workload("auth"), undefined, "deployment ns/app").name, "auth");
});

test("findContainer refuses omitted container on multi-container workloads, listing names", () => {
  assert.throws(() => findContainer(workload("auth", "sidecar"), undefined, "deployment ns/app"), /auth, sidecar.*specify/);
});

test("findContainer rejects a wrong name, listing what exists", () => {
  assert.throws(() => findContainer(workload("auth"), "dev-auth-svc-be", "deployment ns/app"), /not found.*has: auth/);
});

test("only provided resource values enter the patch", () => {
  const p = buildResourcesPatch("api", { memory_limit: "1Gi" });
  assert.deepEqual(p, {
    spec: { template: { spec: { containers: [{ name: "api", resources: { limits: { memory: "1Gi" } } }] } } },
  });
});

test("requests and limits are grouped correctly", () => {
  const p = buildResourcesPatch("api", { cpu_request: "250m", memory_request: "256Mi", memory_limit: "1Gi" });
  const resources = p.spec.template.spec.containers[0].resources;
  assert.deepEqual(resources, { requests: { cpu: "250m", memory: "256Mi" }, limits: { memory: "1Gi" } });
});

test("findRecreatingOwner: controller-owned pods resolve, naked/Job pods do not", () => {
  const rs = { ownerReferences: [{ kind: "ReplicaSet", name: "app-5ccd7547bb", controller: true }] };
  assert.equal(findRecreatingOwner(rs)?.name, "app-5ccd7547bb");
  assert.equal(findRecreatingOwner({ ownerReferences: [] }), null); // naked pod
  assert.equal(findRecreatingOwner(undefined), null);
  assert.equal(findRecreatingOwner({ ownerReferences: [{ kind: "Job", name: "backup", controller: true }] }), null);
  // non-controller reference doesn't count
  assert.equal(findRecreatingOwner({ ownerReferences: [{ kind: "ReplicaSet", name: "x", controller: false }] }), null);
});
