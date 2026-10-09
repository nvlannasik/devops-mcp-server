import { test } from "node:test";
import assert from "node:assert/strict";
import { diffPodTemplates, rolloutChanges, helmChanges, referencedConfigMaps, configChanges, type PodTemplate } from "./changes.js";

const W = { from: new Date("2026-10-08T00:00:00Z"), to: new Date("2026-10-09T00:00:00Z") };
const tpl = (env: Record<string, string>, extra: Partial<{ image: string; restartedAt: string; secret: [string, string] }> = {}): PodTemplate => ({
  metadata: { annotations: extra.restartedAt ? { "kubectl.kubernetes.io/restartedAt": extra.restartedAt } : {} },
  spec: {
    containers: [{
      name: "api",
      image: extra.image ?? "app:latest",
      env: [
        ...Object.entries(env).map(([name, value]) => ({ name, value })),
        ...(extra.secret ? [{ name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: extra.secret[0], key: extra.secret[1] } } }] : []),
      ],
    }],
  },
});

test("an env value change is a field diff, keyed by container", () => {
  assert.deepEqual(diffPodTemplates(tpl({ TIMEOUT_MS: "2000" }), tpl({ TIMEOUT_MS: "50" })), [
    { field: "api.env.TIMEOUT_MS", from: "2000", to: "50" },
  ]);
});

test("an image change and an added env var both show; an absent side reads (none)", () => {
  const d = diffPodTemplates(tpl({}), tpl({ NEW: "1" }, { image: "app:v2" }));
  assert.deepEqual(d, [
    { field: "api.image", from: "app:latest", to: "app:v2" },
    { field: "api.env.NEW", from: "(none)", to: "1" },
  ]);
});

test("a secretKeyRef is rendered as its reference, never a value", () => {
  const d = diffPodTemplates(tpl({}, { secret: ["db", "old"] }), tpl({}, { secret: ["db", "new"] }));
  assert.deepEqual(d, [{ field: "api.env.DB_PASSWORD", from: "secret:db/old", to: "secret:db/new" }]);
});

test("a probe change shows as one serialized field", () => {
  const a = tpl({}); const b = tpl({});
  b.spec!.containers![0].readinessProbe = { httpGet: { path: "/ready", port: 8081 } };
  assert.equal(diffPodTemplates(a, b)[0]?.field, "api.readinessProbe");
});

test("rolloutChanges: restart-only is `restart`, revision 1 is `created`, outside the window is dropped", () => {
  const revs = [
    { revision: 1, at: "2026-10-08T01:00:00Z", template: tpl({ A: "1" }) },
    { revision: 2, at: "2026-10-08T02:00:00Z", template: tpl({ A: "1" }, { restartedAt: "2026-10-08T02:00:00Z" }) },
    { revision: 3, at: "2026-10-08T03:00:00Z", template: tpl({ A: "2" }, { restartedAt: "2026-10-08T02:00:00Z" }) },
  ];
  const c = rolloutChanges("Deployment/api", revs, W);
  assert.deepEqual(c.map((x) => [x.revision, x.kind]), [["3", "spec-change"], ["2", "restart"], ["1", "created"]]);
  assert.deepEqual(c[0].diff, [{ field: "api.env.A", from: "1", to: "2" }]);
  assert.equal(rolloutChanges("Deployment/api", revs, { from: new Date("2026-10-08T02:30:00Z"), to: W.to }).length, 1);
});

test("rolloutChanges: a revision whose predecessor is gone is a spec-change with no diff", () => {
  const c = rolloutChanges("Deployment/api", [{ revision: 7, at: "2026-10-08T05:00:00Z", template: tpl({}) }], W);
  assert.deepEqual(c, [{ at: "2026-10-08T05:00:00Z", source: "rollout", kind: "spec-change", workload: "Deployment/api", revision: "7" }]);
});

test("helmChanges: chart version change is chart-upgrade, digest-only change is values-changed, identical is skipped", () => {
  const history = [
    { version: 9, chartVersion: "1.1.0", configDigest: "b", lastDeployed: "2026-10-08T06:00:00Z" },
    { version: 8, chartVersion: "1.0.1", configDigest: "b", lastDeployed: "2026-10-08T05:00:00Z" },
    { version: 7, chartVersion: "1.0.1", configDigest: "a", lastDeployed: "2026-10-08T04:00:00Z" },
    { version: 6, chartVersion: "1.0.1", configDigest: "a", lastDeployed: "2026-10-08T03:00:00Z" },
    { version: 5, chartVersion: "1.0.0", configDigest: "a", lastDeployed: "2026-10-01T00:00:00Z" },
  ];
  const c = helmChanges("checkout-gateway", history, W);
  assert.deepEqual(c.map((x) => [x.revision, x.kind]), [["9", "chart-upgrade"], ["8", "values-changed"], ["6", "chart-upgrade"]]);
  assert.deepEqual(c[0].diff, [{ field: "chart", from: "1.0.1", to: "1.1.0" }]);
  assert.equal(c[0].workload, "HelmRelease/checkout-gateway");
});

test("helmChanges: the oldest retained history entry is `created` only at version 1; an older version with no older sibling is `deployed`, not a false `created`", () => {
  const v1 = [{ version: 1, chartVersion: "1.0.0", configDigest: "a", lastDeployed: "2026-10-08T06:00:00Z" }];
  assert.deepEqual(helmChanges("x", v1, W).map((c) => c.kind), ["created"]);

  // Flux keeps only a few snapshots: version 34 with no older sibling in status.history is a
  // deploy we can SEE happened, but we cannot see what changed — never "created".
  const v34 = [{ version: 34, chartVersion: "1.1.0", configDigest: "b", lastDeployed: "2026-10-08T06:00:00Z" }];
  assert.deepEqual(helmChanges("devops-ai-stack", v34, W).map((c) => c.kind), ["deployed"]);
});

test("referencedConfigMaps reads env refs, envFrom and volumes", () => {
  const t: PodTemplate = {
    spec: {
      containers: [{ name: "a", env: [{ name: "X", valueFrom: { configMapKeyRef: { name: "one", key: "k" } } }], envFrom: [{ configMapRef: { name: "two" } }] }],
      volumes: [{ name: "v", configMap: { name: "three" } }],
    },
  };
  assert.deepEqual([...referencedConfigMaps([t])].sort(), ["one", "three", "two"]);
});

test("configChanges: only referenced ConfigMaps updated in the window; null = all", () => {
  const cms = [
    { name: "one", managedFields: [{ time: "2026-09-01T00:00:00Z" }, { time: "2026-10-08T07:00:00Z" }] },
    { name: "two", managedFields: [{ time: "2026-09-01T00:00:00Z" }] },
    { name: "other", managedFields: [{ time: "2026-10-08T08:00:00Z" }] },
  ];
  assert.deepEqual(configChanges(cms, new Set(["one", "two"]), W), [
    { at: "2026-10-08T07:00:00Z", source: "config", kind: "config-updated", workload: "ConfigMap/one" },
  ]);
  assert.equal(configChanges(cms, null, W).length, 2);
});
