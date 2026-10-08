import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineSources } from "./changes-handler.js";

const NOW = new Date("2026-10-09T00:00:00Z");
const tpl = (v: string) => ({ spec: { containers: [{ name: "api", env: [{ name: "A", value: v }], envFrom: [{ configMapRef: { name: "cfg" } }] }] } });
const ok: TimelineSources = {
  rollouts: async () => [{ workload: "Deployment/api", revisions: [
    { revision: 1, at: "2026-10-01T00:00:00Z", template: tpl("1") },
    { revision: 2, at: "2026-10-08T10:00:00Z", template: tpl("2") },
  ] }],
  helmReleases: async () => [{ name: "api", namespace: "flux-app", history: [{ version: 2, chartVersion: "1", configDigest: "b", lastDeployed: "2026-10-08T09:59:00Z" }, { version: 1, chartVersion: "1", configDigest: "a", lastDeployed: "2026-10-01T00:00:00Z" }] }],
  configMaps: async () => [{ name: "cfg", managedFields: [{ time: "2026-10-08T09:58:00Z" }] }, { name: "unrelated", managedFields: [{ time: "2026-10-08T09:00:00Z" }] }],
};
const boom = (m: string) => async () => { throw new Error(m); };

// Shape of @kubernetes/client-node ApiException (see src/utils/errors/index.test.ts): a huge
// multi-line .message dump plus the API's real reason nested in the raw-JSON .body.
const apiException = () =>
  Object.assign(
    new Error(
      'HTTP-Code: 403\nMessage: Unknown API Status Code!\nBody: "{\\"kind\\":\\"Status\\"}"\nHeaders: {"audit-id":"x"}'
    ),
    { body: '{"kind":"Status","status":"Failure","message":"helmreleases.helm.toolkit.fluxcd.io is forbidden","code":403}' }
  );

test("all sources read: merged newest first, HelmReleases listed, nothing unread", async () => {
  const r = await buildTimeline(ok, "apps", 24, NOW);
  assert.deepEqual(r.changes.map((c) => c.workload), ["Deployment/api", "HelmRelease/api", "ConfigMap/cfg"]);
  assert.deepEqual(r.helmReleases, [{ name: "api", namespace: "flux-app" }]);
  assert.deepEqual(r.unread, []);
  assert.equal(r.window.from, "2026-10-08T00:00:00.000Z");
});

test("a failing source is unread with its error; the others still return", async () => {
  const r = await buildTimeline({ ...ok, helmReleases: boom("403 forbidden") }, "apps", 24, NOW);
  assert.deepEqual(r.unread, ["helm: 403 forbidden"]);
  assert.equal(r.helmReleases.length, 0);
  assert.ok(r.changes.some((c) => c.workload === "Deployment/api"));
});

test("rollouts unread: every ConfigMap updated in the window counts", async () => {
  const r = await buildTimeline({ ...ok, rollouts: boom("timeout") }, "apps", 24, NOW);
  assert.deepEqual(r.unread, ["rollout: timeout"]);
  assert.deepEqual(r.changes.filter((c) => c.source === "config").map((c) => c.workload).sort(), ["ConfigMap/cfg", "ConfigMap/unrelated"]);
});

test("an ApiException-shaped failure is reduced to its concise reason in unread, not the raw HTTP dump", async () => {
  const r = await buildTimeline({ ...ok, helmReleases: async () => { throw apiException(); } }, "apps", 24, NOW);
  assert.equal(r.unread.length, 1);
  assert.ok(r.unread[0].includes("forbidden"), r.unread[0]);
  assert.ok(!r.unread[0].includes("Headers"), r.unread[0]);
  assert.ok(!r.unread[0].includes("HTTP-Code"), r.unread[0]);
});

test("capped at 50 changes", async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `cm${i}`, managedFields: [{ time: `2026-10-08T${String(i % 24).padStart(2, "0")}:00:00Z` }] }));
  // rollouts unread → every ConfigMap counts, so all 60 are candidates
  const r = await buildTimeline({ ...ok, configMaps: async () => many, rollouts: boom("x") }, "apps", 24, NOW);
  assert.equal(r.changes.length, 50);
});
