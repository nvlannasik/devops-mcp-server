import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeByName, type KindResult } from "./find.js";

const item = (namespace: string, extra: { labels?: Record<string, string>; owner?: [string, string] } = {}) => ({
  metadata: {
    name: "x",
    namespace,
    labels: extra.labels,
    creationTimestamp: "2026-09-26T19:04:40Z",
    ownerReferences: extra.owner ? [{ kind: extra.owner[0], name: extra.owner[1], controller: true }] : undefined,
  },
});
const none = (kind: string): KindResult => ({ kind, items: [] });

// The C10 miss, the right way round: the name belongs to a Service, and asking only about
// Deployments would have come back empty.
test("a name carried by one kind is reported as that kind", () => {
  const r = summarizeByName("bench-c10-cache", "bench-c10", [none("Deployment"), { kind: "Service", items: [item("bench-c10")] }]);
  assert.deepEqual(r.matches.map((m) => m.kind), ["Service"]);
  assert.equal(r.matches[0].managedBy, "none");
  assert.match(r.note, /is a Service/);
});

// Verbatim shape of `loki` in monitoring, checked live on 2026-09-28: four kinds, one name.
test("a name shared by several kinds asks which one is meant", () => {
  const r = summarizeByName("loki", "monitoring", [
    { kind: "StatefulSet", items: [item("monitoring")] },
    { kind: "Service", items: [item("monitoring")] },
    { kind: "ConfigMap", items: [item("monitoring")] },
  ]);
  assert.match(r.note, /more than one kind \(StatefulSet, Service, ConfigMap\)/);
});

test("no match is evidence of absence — for the kinds searched, and it says so", () => {
  const r = summarizeByName("nope", undefined, [none("Deployment"), none("Service")]);
  assert.equal(r.matches.length, 0);
  assert.deepEqual(r.searched, ["Deployment", "Service"]);
  assert.match(r.note, /Nothing named `nope` exists in any namespace/);
  assert.match(r.note, /k8s_get_custom_resources/);
});

// The load-bearing one: a kind RBAC would not let us read must never turn into "not found".
test("a kind that could not be read is reported, not silently counted as absent", () => {
  const r = summarizeByName("db-creds", "prod", [none("Deployment"), { kind: "Secret", error: "secrets is forbidden" }]);
  assert.deepEqual(r.unreadable, ["Secret"]);
  assert.deepEqual(r.searched, ["Deployment"]);
  assert.match(r.note, /Could NOT read: Secret — absence there is unknown/);
});

test("provenance and ownership ride along — declared-in-Git and owned objects look different", () => {
  const r = summarizeByName("api-7f9c", "shop", [
    { kind: "Pod", items: [item("shop", { owner: ["ReplicaSet", "api-7f9c5d"] })] },
    { kind: "ConfigMap", items: [item("shop", { labels: { "kustomize.toolkit.fluxcd.io/name": "apps" } })] },
  ]);
  assert.equal(r.matches[0].ownedBy, "ReplicaSet/api-7f9c5d");
  assert.equal(r.matches[1].managedBy, "flux");
  assert.equal(r.matches[1].createdAt, "2026-09-26T19:04:40.000Z");
});

// Bench C05, 2026-09-28: the NAMESPACE name was looked up as an object, the answer said nothing
// carried it, and the model invented object names to fill the gap.
test("a name that is a namespace is said to be one, and pointed at namespace-scoped tools", () => {
  const r = summarizeByName("bench-c05", undefined, [none("Deployment"), none("Service")], true);
  assert.equal(r.isNamespace, true);
  assert.match(r.note, /is a NAMESPACE/);
  assert.doesNotMatch(r.note, /Nothing named/, "must not read as plain absence");
});

test("a match carries the pointer to the unused scan, because a delete can only follow that scan", () => {
  const r = summarizeByName("bench-c10-cache", "bench-c10", [{ kind: "Service", items: [item("bench-c10")] }]);
  assert.match(r.note, /k8s_find_unused_resources/);
  assert.match(r.note, /orphanKeys/);
});
