import { test } from "node:test";
import assert from "node:assert/strict";
import { explainEmptyVector, metricsInQuery } from "./index.js";

const known = new Set([
  "http_server_requests_total",
  "http_client_requests_total",
  "http_server_request_duration_seconds_bucket",
  "kube_pod_status_phase",
  "up",
]);

// Measured 2026-08-31: the agent's prompt said http_requests_total, the apps expose
// http_server_requests_total, and the call came back `ok (35 chars)` with nothing saying why.
test("a metric that does not exist is named, with the near miss that does", () => {
  const r = explainEmptyVector('sum by (service) (rate(http_requests_total{service="orders-api"}[5m]))', known)!;
  assert.equal(r.emptyResult, "unknown_metric");
  assert.deepEqual(r.unknownMetrics, ["http_requests_total"]);
  assert.ok(r.didYouMean?.includes("http_server_requests_total"));
  assert.match(r.note, /NAME is wrong/);
});

test("every metric exists and there is no comparison → the matchers matched nothing", () => {
  const r = explainEmptyVector('rate(http_server_requests_total{service="nope"}[5m])', known)!;
  assert.equal(r.emptyResult, "no_series_match");
  assert.match(r.note, /label values/);
});

// An empty result behind a threshold is often the real answer ("nothing is above it"), and telling
// the model otherwise would send it hunting for a fault that is not there.
test("a comparison outside the braces makes empty a possible answer, not a failure", () => {
  const r = explainEmptyVector('sum(rate(http_server_requests_total{status=~"5.."}[5m])) > 0.5', known)!;
  assert.equal(r.emptyResult, "no_series_match");
  assert.match(r.note, /can itself be the answer/);
});

// `!=` and `=~` inside a selector are matchers, not comparisons.
test("matcher operators inside braces are not mistaken for a threshold", () => {
  const r = explainEmptyVector('kube_pod_status_phase{phase!="Running",namespace=~"bench-.*"}', known)!;
  assert.doesNotMatch(r.note, /threshold/);
});

test("only a name followed by `{` or `[` counts as a metric — functions and labels never do", () => {
  assert.deepEqual(metricsInQuery('sum by (namespace) (rate(http_server_requests_total{job="x"}[5m]))'), [
    "http_server_requests_total",
  ]);
  // A bare selector is invisible to this check, and the answer is then "no note", never a wrong one.
  assert.equal(explainEmptyVector("up == 0", known), null);
});

// Verbatim from the first run against the live Prometheus, 2026-09-27: a bare range selector, no
// braces, and the first version of this check returned it without a note.
test("a bare range selector is a metric too", () => {
  assert.deepEqual(metricsInQuery("sum(rate(http_server_requests_total[5m])) > 1e9"), ["http_server_requests_total"]);
  const r = explainEmptyVector("sum(rate(http_server_requests_total[5m])) > 1e9", known)!;
  assert.equal(r.emptyResult, "no_series_match");
  assert.match(r.note, /can itself be the answer/);
  assert.equal(explainEmptyVector("rate(http_requests_total[5m])", known)?.emptyResult, "unknown_metric");
});
