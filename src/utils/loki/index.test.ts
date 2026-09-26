import { test } from "node:test";
import assert from "node:assert/strict";
import { explainEmptyLogs } from "./index.js";

// The 2026-09-24..26 outage: fluentbit wedged, Loki held nothing from any namespace for 36 hours,
// and every empty answer in that window read as "the container logged nothing".
test("no namespace has logs at all → the pipeline, not the workload", () => {
  const r = explainEmptyLogs('{namespace="bench-b04", app="payments"}', []);
  assert.equal(r.verdict, "pipeline_silent");
  assert.match(r.note, /NOT evidence that the workload logged nothing/);
  assert.match(r.note, /k8s_get_pod_logs/);
});

// B04's other failure shape: Loki is fine, but a container that logs and dies within seconds leaves
// a file the shipper never scanned.
test("Loki is ingesting, but not from the namespace asked about", () => {
  const r = explainEmptyLogs('{namespace="bench-b04"} |~ "(?i)database_url"', ["flux-system", "monitoring"]);
  assert.equal(r.verdict, "namespace_silent");
  assert.equal(r.namespacesWithLogs, 2);
  assert.match(r.note, /none from `bench-b04`/);
});

test("the namespace has logs, the query just matched none of them", () => {
  const r = explainEmptyLogs('{namespace="sample-apps"} |= "panic"', ["sample-apps", "monitoring"]);
  assert.equal(r.verdict, "no_match");
  assert.match(r.note, /including from `sample-apps`/);
  assert.match(r.note, /not proof the event never happened/);
});

// A regex matcher could cover several namespaces; calling one of them "silent" would be a guess.
test("a regex namespace matcher never produces a namespace verdict", () => {
  assert.equal(explainEmptyLogs('{namespace=~"bench-.*"}', ["monitoring"]).verdict, "no_match");
  assert.equal(explainEmptyLogs('{app="api"}', ["monitoring"]).verdict, "no_match");
});

// The contract with devops-ai-agent: its sawLogLines test is "result length >= 200", which this
// object passes while holding nothing, so the agent excludes anything carrying this exact field.
test("every empty verdict carries the marker the agent keys on, in the exact serialised form", () => {
  for (const r of [
    explainEmptyLogs('{namespace="a"}', []),
    explainEmptyLogs('{namespace="a"}', ["b"]),
    explainEmptyLogs('{namespace="a"}', ["a"]),
  ]) {
    const wire = JSON.stringify(r); // exactly what src/app/index.ts sends
    assert.match(wire, /"noLogLines":true/);
    assert.deepEqual(r.streams, []);
    assert.ok(wire.length >= 200, "long enough that the marker, not the size, has to be what the agent reads");
  }
});
