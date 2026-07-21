import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResourcesPatch, findContainer } from "./remediation.js";

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
