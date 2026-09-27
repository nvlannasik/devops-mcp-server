import { test } from "node:test";
import assert from "node:assert/strict";
import { pickContainer } from "./pods.js";

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
