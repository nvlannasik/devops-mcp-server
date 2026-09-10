import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCpu, parseMem, aggregateUsage, buildRecommendations, type WorkloadContainer } from "./rightsizing.js";

const MiB = 1024 * 1024;
const container = (over: Partial<WorkloadContainer> = {}): WorkloadContainer => ({
  kind: "Deployment",
  namespace: "app",
  workload: "orders-api",
  container: "api",
  replicas: 3,
  cpuRequest: 0.5,
  memRequest: 512 * MiB,
  cpuLimit: 1,
  memLimit: 512 * MiB,
  ...over,
});

test("quantities parse in the units Kubernetes actually writes", () => {
  assert.equal(parseCpu("100m"), 0.1);
  assert.equal(parseCpu("2"), 2);
  assert.equal(parseCpu(undefined), null);
  assert.equal(parseMem("512Mi"), 512 * MiB);
  assert.equal(parseMem("1Gi"), 1024 * MiB);
  assert.equal(parseMem("500M"), 5e8);
  assert.equal(parseMem("bogus"), null);
});

test("a pod maps to the LONGEST matching workload name, not the first", () => {
  const cs = [container({ workload: "orders" }), container({ workload: "orders-api" })];
  const usage = aggregateUsage(cs, {
    cpu: new Map([["app/orders-api-7c9d4-x2k/api", 0.4]]),
    mem: new Map(),
    throttle: new Map(),
  });
  assert.equal(usage.get("app/Deployment/orders-api/api")?.cpuCores, 0.4);
  assert.equal(usage.get("app/Deployment/orders/api"), undefined);
});

test("usage takes the busiest replica, never the average", () => {
  const cs = [container()];
  const usage = aggregateUsage(cs, {
    cpu: new Map([["app/orders-api-1/api", 0.2], ["app/orders-api-2/api", 0.9]]),
    mem: new Map(),
    throttle: new Map(),
  });
  assert.equal(usage.get("app/Deployment/orders-api/api")?.cpuCores, 0.9);
});

test("memory near the limit is flagged oom_risk and the recommendation raises it", () => {
  const c = container({ memLimit: 512 * MiB, memRequest: 512 * MiB });
  const out = buildRecommendations([c], new Map([["app/Deployment/orders-api/api", { memBytes: 500 * MiB, cpuCores: 0.4 }]]));
  const r = out.recommendations[0];
  assert.ok(r.flags.includes("oom_risk"));
  assert.equal(r.recommended!.memoryLimit, "750Mi"); // 500Mi x 1.5
  assert.equal(r.recommended!.memoryRequest, "600Mi"); // 500Mi x 1.2
});

test("an over-provisioned container reports savings multiplied by replica count", () => {
  const c = container({ cpuRequest: 1, memRequest: 1024 * MiB, memLimit: 2048 * MiB, replicas: 3 });
  const out = buildRecommendations([c], new Map([["app/Deployment/orders-api/api", { cpuCores: 0.1, memBytes: 100 * MiB }]]));
  const r = out.recommendations[0];
  assert.ok(r.flags.includes("over_provisioned"));
  assert.equal(r.recommended!.cpuRequest, "115m");
  // (1 - 0.115) cores x 3 replicas
  assert.ok(Math.abs(r.savings!.cpuCores - 2.655) < 1e-9);
  assert.equal(out.potentialRequestSavings.cpu, "2655m");
});

test("a CPU limit is raised when throttling, never invented where none exists", () => {
  const throttled = buildRecommendations(
    [container({ cpuLimit: 0.5 })],
    new Map([["app/Deployment/orders-api/api", { cpuCores: 0.6, throttleRatio: 0.3 }]])
  ).recommendations[0];
  assert.ok(throttled.flags.includes("cpu_throttled"));
  assert.equal(throttled.recommended!.cpuLimit, "1200m");
  assert.equal(throttled.observed.cpuThrottlePct, 30);

  const noLimit = buildRecommendations(
    [container({ cpuLimit: null })],
    new Map([["app/Deployment/orders-api/api", { cpuCores: 0.6, throttleRatio: 0.3 }]])
  ).recommendations[0];
  assert.equal(noLimit.recommended!.cpuLimit, undefined);
  assert.ok(!noLimit.flags.includes("cpu_throttled"));
});

test("a container with no metrics gets no_data and no invented recommendation", () => {
  const out = buildRecommendations([container()], new Map());
  assert.deepEqual(out.recommendations[0].flags, ["no_data"]);
  assert.equal(out.recommendations[0].recommended, undefined);
  assert.equal(out.scanned.withMetrics, 0);
});

test("a container with no requests at all is flagged before the merely wasteful ones", () => {
  const out = buildRecommendations(
    [
      container({ workload: "fat", cpuRequest: 1, memRequest: 1024 * MiB }),
      container({ workload: "bare", cpuRequest: null, memRequest: null, cpuLimit: null, memLimit: null }),
    ],
    new Map([
      ["app/Deployment/fat/api", { cpuCores: 0.05, memBytes: 50 * MiB }],
      ["app/Deployment/bare/api", { cpuCores: 0.05, memBytes: 50 * MiB }],
    ])
  );
  assert.equal(out.recommendations[0].workload, "bare");
  assert.ok(out.recommendations[0].flags.includes("no_requests"));
});
