import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCpu,
  parseMem,
  aggregateUsage,
  buildRecommendations,
  idleWorkloadsOf,
  windowHours,
  IDLE_MIN_WINDOW_HOURS,
  type WorkloadContainer,
} from "./rightsizing.js";

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

// ── Idle detection ───────────────────────────────────────────────────────────
// This flag is the ONLY input to the scale-to-zero quarantine, so a false positive here is a
// workload taken offline by an approval card. Everything below is about refusing to emit it.

const usageOf = (c: WorkloadContainer, cpuCores: number, memBytes = 100 * MiB) =>
  new Map([[`${c.namespace}/${c.kind}/${c.workload}/${c.container}`, { cpuCores, memBytes }]]);

test("window strings convert to hours in the units the schema allows", () => {
  assert.equal(windowHours("24h"), 24);
  assert.equal(windowHours("7d"), 168);
  assert.equal(windowHours("90m"), 1.5);
});

test("a workload doing nothing for a day is idle", () => {
  const c = container({ replicas: 2 });
  const out = buildRecommendations([c], usageOf(c, 0.0005), 24);
  assert.ok(out.recommendations[0].flags.includes("idle"), out.recommendations[0].flags.join(", "));
  assert.deepEqual(out.idleWorkloads, [
    { key: "app/Deployment/orders-api", kind: "Deployment", namespace: "app", workload: "orders-api", replicas: 2, cpuP95Below: "2m" },
  ]);
});

// An hour of quiet is not evidence. A workload that bursts nightly is quiet for most of any
// short window, and this flag is what would take it down.
test("a short window never produces an idle verdict", () => {
  const c = container();
  for (const hours of [0, 1, IDLE_MIN_WINDOW_HOURS - 1]) {
    const out = buildRecommendations([c], usageOf(c, 0), hours);
    assert.equal(out.recommendations[0].flags.includes("idle"), false, `idle at ${hours}h`);
    assert.deepEqual(out.idleWorkloads, [], `idle workload at ${hours}h`);
  }
});

// Probes cost CPU, so a pod being probed is never at literal zero — but a pod serving real
// requests is far above the floor. This is the line between those two.
test("a workload serving real traffic is not idle", () => {
  const c = container();
  const out = buildRecommendations([c], usageOf(c, 0.05), 24);
  assert.equal(out.recommendations[0].flags.includes("idle"), false);
  assert.deepEqual(out.idleWorkloads, []);
});

// Already at zero: flagging it would offer to scale it to the number it is at.
test("a workload already scaled to zero is not an idle candidate", () => {
  const c = container({ replicas: 0 });
  const out = buildRecommendations([c], usageOf(c, 0), 24);
  assert.equal(out.recommendations[0].flags.includes("idle"), false);
  assert.deepEqual(out.idleWorkloads, []);
});

// The roll-up is where a half-measured workload has to be refused: the container with no
// samples is exactly where the traffic would have shown.
test("a workload is idle only when EVERY container is measured and idle", () => {
  const api = container({ container: "api" });
  const side = container({ container: "sidecar" });

  const bothIdle = buildRecommendations([api, side], new Map([
    ...usageOf(api, 0), ...usageOf(side, 0),
  ]), 24);
  assert.equal(bothIdle.idleWorkloads.length, 1);

  const oneBusy = buildRecommendations([api, side], new Map([
    ...usageOf(api, 0), ...usageOf(side, 0.4),
  ]), 24);
  assert.deepEqual(oneBusy.idleWorkloads, [], "one busy container did not save the workload");

  // sidecar has no samples at all -> no_data -> the workload is half-measured, not idle
  const oneUnmeasured = buildRecommendations([api, side], usageOf(api, 0), 24);
  assert.deepEqual(oneUnmeasured.idleWorkloads, [], "an unmeasured container did not block the verdict");
});

test("a workload with no metrics at all is never idle", () => {
  const c = container();
  assert.deepEqual(idleWorkloadsOf(buildRecommendations([c], new Map(), 24).recommendations), []);
});
