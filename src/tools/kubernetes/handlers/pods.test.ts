import { test } from "node:test";
import assert from "node:assert/strict";
import { pickContainer, selectorMissNote } from "./pods.js";

// Live 2026-09-29: `app=checkout-gateway` returned `[]` twice in one investigation; the chart
// labels `app.kubernetes.io/name`. Label sets below are the sample-apps pods' own, trimmed.
const sampleApps = ["checkout-gateway", "orders-api", "storefront"].map((name) => ({
  "app.kubernetes.io/name": name,
  "app.kubernetes.io/managed-by": "Helm",
  "pod-template-hash": "774f8b79dd",
}));

test("an empty selector result names the key the value really lives under", () => {
  const note = selectorMissNote("sample-apps", "app=checkout-gateway", sampleApps);
  assert.match(note, /`app\.kubernetes\.io\/name=checkout-gateway` \(1 pod\(s\)\) — use that as label_selector/);
});

test("a value found nowhere lists the keys in use, and an empty namespace says so", () => {
  const note = selectorMissNote("sample-apps", "app=payments", sampleApps);
  assert.match(note, /no pod there carries that value/);
  assert.match(note, /3 pod\(s\) in the namespace; label keys in use: app\.kubernetes\.io\/managed-by, app\.kubernetes\.io\/name, pod-template-hash/);
  assert.match(selectorMissNote("empty-ns", "app=x", []), /no pod at all/);
});

// Bench C06: "check the logs for api" — three Deployments whose `app` values all contain "api".
const c06 = ["api-gateway", "payments-api", "api-worker"].flatMap((app) =>
  Array.from({ length: 4 }, (_, i) => ({ app, "pod-template-hash": `${app}-h${i}` }))
);

test("a shortened name lists the label values that contain it, and says the name is ambiguous", () => {
  const note = selectorMissNote("bench-c06", "app=api", c06);
  assert.match(note, /matches `app=api` exactly, but 3 label value\(s\) contain it/);
  assert.match(note, /`app=api-gateway` \(4 pod\(s\)\), `app=payments-api` \(4 pod\(s\)\), `app=api-worker` \(4 pod\(s\)\)/);
  assert.match(note, /ambiguous/);
  // per-pod keys are never candidates, though every hash above contains "api"
  assert.doesNotMatch(note, /pod-template-hash/);
  // the selector's key may be wrong too: a name key is still searched
  assert.match(selectorMissNote("sample-apps", "name=checkout", sampleApps), /`app\.kubernetes\.io\/name=checkout-gateway` \(1 pod\(s\)\)\. It is a candidate, not a match/);
  // one letter matches everything and says nothing
  assert.match(selectorMissNote("bench-c06", "app=a", c06), /no pod there carries that value/);
});

test("a set-based or existence selector does not crash the note", () => {
  assert.match(selectorMissNote("sample-apps", "app in (a,b),tier", sampleApps), /label keys in use/);
});

const pod = (
  containers: Array<[name: string, ready: boolean, restarts: number]>,
  extra: { annotation?: string; init?: string[] } = {}
) => ({
  metadata: extra.annotation ? { annotations: { "kubectl.kubernetes.io/default-container": extra.annotation } } : {},
  spec: { containers: containers.map(([name]) => ({ name })), initContainers: (extra.init ?? []).map((name) => ({ name })) },
  status: { containerStatuses: containers.map(([name, ready, restartCount]) => ({ name, ready, restartCount })) },
});

test("a single-container pod is not this function's business", () => {
  assert.equal(pickContainer(pod([["app", false, 5]]), false), null);
});

// The sidecar pattern: the main container is fine and the proxy beside it fails readiness.
test("the not-ready container wins over the default and over the first", () => {
  const r = pickContainer(pod([["app", true, 0], ["envoy", false, 0]], { annotation: "app" }), false)!;
  assert.equal(r.container, "envoy");
  assert.deepEqual(r.otherContainers, ["app"]);
  assert.match(r.because, /not ready/);
});

test("previous: true reads the container that actually restarted", () => {
  const r = pickContainer(pod([["app", false, 0], ["migrator", true, 4]]), true)!;
  assert.equal(r.container, "migrator");
  assert.match(r.because, /restarted 4 time/);
});

test("nothing failing: the default-container annotation, then the first container", () => {
  // Verbatim shape of loki-0 in this cluster, checked live on 2026-09-28.
  assert.equal(pickContainer(pod([["loki", true, 0], ["loki-sc-rules", true, 0]], { annotation: "loki" }), false)!.container, "loki");
  assert.equal(pickContainer(pod([["a", true, 0], ["b", true, 0]]), false)!.container, "a");
  // An annotation naming a container that does not exist is ignored, not trusted.
  assert.equal(pickContainer(pod([["a", true, 0], ["b", true, 0]], { annotation: "gone" }), false)!.container, "a");
});

test("init containers are listed separately, so they can be asked for by name", () => {
  const r = pickContainer(pod([["a", true, 0], ["b", true, 0]], { init: ["migrate"] }), false)!;
  assert.deepEqual(r.initContainers, ["migrate"]);
  assert.ok(!r.otherContainers.includes("migrate"));
});
