import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeClusterHealth, type PodLike } from "./health.js";

const NOW = Date.parse("2026-08-08T10:00:00Z");
const opts = (over: Partial<{ complete: boolean; restartWindowMinutes: number }> = {}) => ({
  complete: true,
  restartWindowMinutes: 60,
  now: NOW,
  ...over,
});

const pod = (over: Partial<PodLike> & { ns?: string; name?: string } = {}): PodLike => ({
  metadata: { name: over.name ?? "p", namespace: over.ns ?? "default", ...over.metadata },
  spec: { nodeName: "node-1", ...over.spec },
  status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 0 }], ...over.status },
});

test("a CrashLoopBackOff pod is Running — readiness is what finds it, not phase", () => {
  const out = shapeClusterHealth(
    [
      pod({ ns: "dev-auth", name: "api-1", status: { phase: "Running", containerStatuses: [{ ready: false, restartCount: 7, state: { waiting: { reason: "CrashLoopBackOff" } } }] } }),
      pod({ ns: "dev-auth", name: "api-2" }),
    ],
    opts()
  );

  assert.equal(out.summary.running, 2); // phase says both are fine
  assert.equal(out.summary.notReady, 1); // readiness disagrees
  assert.equal(out.unhealthyTotal, 1);
  assert.equal(out.unhealthy[0].name, "api-1");
  assert.equal(out.unhealthy[0].reason, "CrashLoopBackOff");
  assert.equal(out.unhealthy[0].restarts, 7);
});

test("a completed Job pod is counted, never reported as a fault", () => {
  const out = shapeClusterHealth(
    [pod({ name: "backup", status: { phase: "Succeeded", containerStatuses: [{ ready: false, restartCount: 0, state: { terminated: { reason: "Completed" } } }] } })],
    opts()
  );
  assert.equal(out.summary.succeeded, 1);
  assert.equal(out.summary.notReady, 0); // Succeeded never counts as not-ready
  assert.equal(out.unhealthyTotal, 0);
});

test("scanned proves coverage — pods and namespaces actually looked at", () => {
  const out = shapeClusterHealth(
    [pod({ ns: "a" }), pod({ ns: "b" }), pod({ ns: "b", name: "q" })],
    opts()
  );
  assert.deepEqual(out.scanned, { pods: 3, namespaces: 2, complete: true });
});

test("complete:false survives to the caller — a capped scan must not read as all-clear", () => {
  const out = shapeClusterHealth([pod()], opts({ complete: false }));
  assert.equal(out.scanned.complete, false);
  assert.equal(out.unhealthyTotal, 0); // nothing wrong in what we saw, but the scan was partial
});

test("reason prefers a real fault over a transient waiting state", () => {
  const out = shapeClusterHealth(
    [
      pod({
        name: "multi",
        status: {
          phase: "Pending",
          containerStatuses: [
            { ready: false, restartCount: 0, state: { waiting: { reason: "PodInitializing" } } },
            { ready: false, restartCount: 0, state: { waiting: { reason: "ImagePullBackOff" } } },
          ],
        },
      }),
    ],
    opts()
  );
  assert.equal(out.unhealthy[0].reason, "ImagePullBackOff");
});

test("a transient reason is still reported when there is nothing better", () => {
  const out = shapeClusterHealth(
    [pod({ name: "stuck", status: { phase: "Pending", containerStatuses: [{ ready: false, restartCount: 0, state: { waiting: { reason: "ContainerCreating" } } }] } })],
    opts()
  );
  assert.equal(out.unhealthy[0].reason, "ContainerCreating");
});

test("OOMKilled is read from the last termination, not the waiting state", () => {
  const out = shapeClusterHealth(
    [
      pod({
        name: "hungry",
        status: {
          phase: "Running",
          containerStatuses: [{ ready: false, restartCount: 3, state: { waiting: { reason: "CrashLoopBackOff" } }, lastState: { terminated: { reason: "OOMKilled" } } }],
        },
      }),
    ],
    opts()
  );
  // waiting wins when both exist — it is the current state
  assert.equal(out.unhealthy[0].reason, "CrashLoopBackOff");

  const noWait = shapeClusterHealth(
    [pod({ name: "hungry", status: { phase: "Running", containerStatuses: [{ ready: false, restartCount: 3, lastState: { terminated: { reason: "OOMKilled" } } }] } })],
    opts()
  );
  assert.equal(noWait.unhealthy[0].reason, "OOMKilled");
});

test("a ready pod that restarted inside the window is flagged as recently restarted, not unhealthy", () => {
  const out = shapeClusterHealth(
    [
      pod({
        name: "flapping",
        status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 2, lastState: { terminated: { reason: "Error", finishedAt: new Date(NOW - 5 * 60 * 1000) } } }] },
      }),
    ],
    opts()
  );
  assert.equal(out.unhealthyTotal, 0);
  assert.equal(out.recentlyRestartedTotal, 1);
  assert.equal(out.recentlyRestarted[0].name, "flapping");
});

test("a restart older than the window is not reported at all", () => {
  const out = shapeClusterHealth(
    [
      pod({
        name: "settled",
        status: { phase: "Running", containerStatuses: [{ ready: true, restartCount: 2, lastState: { terminated: { reason: "Error", finishedAt: new Date(NOW - 6 * 60 * 60 * 1000) } } }] },
      }),
    ],
    opts()
  );
  assert.equal(out.unhealthyTotal, 0);
  assert.equal(out.recentlyRestartedTotal, 0);
});

test("terminating pods are marked and sorted last — a rollout must not crowd out the real fault", () => {
  const out = shapeClusterHealth(
    [
      pod({ name: "old-replica", metadata: { name: "old-replica", namespace: "web", deletionTimestamp: new Date(NOW) }, status: { phase: "Running", containerStatuses: [{ ready: false, restartCount: 0 }] } }),
      pod({ name: "broken", status: { phase: "Failed", containerStatuses: [{ ready: false, restartCount: 0 }] } }),
    ],
    opts()
  );
  assert.equal(out.unhealthyTotal, 2);
  assert.equal(out.unhealthy[0].name, "broken"); // Failed outranks a terminating pod
  assert.equal(out.unhealthy[0].terminating, undefined);
  assert.equal(out.unhealthy[1].terminating, true);
});

test("lists are capped but the totals never are", () => {
  const many = Array.from({ length: 120 }, (_, i) =>
    pod({ name: `bad-${i}`, status: { phase: "Failed", containerStatuses: [{ ready: false, restartCount: 0 }] } })
  );
  const out = shapeClusterHealth(many, opts());
  assert.equal(out.unhealthyTotal, 120); // the count is the honest part
  assert.equal(out.unhealthy.length, 50); // the payload is the bounded part
});

test("a pod reporting no container statuses is not silently healthy", () => {
  const out = shapeClusterHealth([pod({ name: "blank", status: { phase: "Running", containerStatuses: [] } })], opts());
  assert.equal(out.summary.notReady, 1);
  assert.equal(out.unhealthyTotal, 1);
});

test("an all-green cluster reports empty lists, not an empty answer", () => {
  const out = shapeClusterHealth([pod({ ns: "a" }), pod({ ns: "b" })], opts());
  assert.deepEqual(out.unhealthy, []);
  assert.deepEqual(out.recentlyRestarted, []);
  assert.equal(out.summary.running, 2);
  assert.equal(out.scanned.namespaces, 2);
  assert.equal(out.scanned.complete, true);
});
