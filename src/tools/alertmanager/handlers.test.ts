import { test } from "node:test";
import assert from "node:assert/strict";
import { alertStatus, shapeGroups, MAX_DETAIL_ALERTS } from "./handlers.js";

const alert = (over: Record<string, unknown> = {}) => ({
  labels: { alertname: "KubePodCrashLooping", namespace: "payments", severity: "critical" },
  annotations: { summary: "pod is restarting" },
  startsAt: "2026-08-16T10:00:00.000Z",
  fingerprint: "f1",
  status: { state: "active", silencedBy: [], inhibitedBy: [] },
  ...over,
});

const group = (alerts: unknown[], over: Record<string, unknown> = {}) => ({
  labels: { alertname: "KubePodCrashLooping" },
  receiver: { name: "slack" },
  alerts,
  ...over,
});

// ---- alertStatus ----

test("alertStatus labels rather than filters: silenced and inhibited both come back", () => {
  assert.equal(alertStatus({ state: "active", silencedBy: [], inhibitedBy: [] }), "active");
  assert.equal(alertStatus({ state: "suppressed", silencedBy: ["sil-1"], inhibitedBy: [] }), "silenced");
  assert.equal(alertStatus({ state: "suppressed", silencedBy: [], inhibitedBy: ["fp-9"] }), "inhibited");
});

test("alertStatus passes an unknown state through instead of guessing", () => {
  assert.equal(alertStatus({ state: "unprocessed" }), "unprocessed");
  assert.equal(alertStatus({ state: "somethingNew" }), "somethingNew");
  assert.equal(alertStatus(undefined), "unknown");
  assert.equal(alertStatus({}), "unknown");
});

// ---- shapeGroups ----

test("shapeGroups keeps Alertmanager's grouping and the fields an RCA reads", () => {
  const out = shapeGroups([group([alert()])]);
  assert.equal(out.groups.length, 1);
  assert.deepEqual(out.groups[0].groupLabels, { alertname: "KubePodCrashLooping" });
  assert.equal(out.groups[0].receiver, "slack");

  const a = out.groups[0].alerts[0];
  assert.equal(a.name, "KubePodCrashLooping");
  assert.equal(a.status, "active");
  assert.equal(a.severity, "critical");
  assert.equal(a.summary, "pod is restarting");
  assert.equal(a.startsAt, "2026-08-16T10:00:00.000Z");
  assert.equal(a.fingerprint, "f1");
  assert.equal(a.labels.namespace, "payments");
});

test("a silenced alert is returned, labelled, and names the silence that muted it", () => {
  const out = shapeGroups([
    group([alert({ status: { state: "suppressed", silencedBy: ["sil-42"], inhibitedBy: [] } })]),
  ]);
  const a = out.groups[0].alerts[0] as { status: string; silencedBy?: string[] };
  assert.equal(a.status, "silenced", "a silenced alert is still firing — dropping it would read as recovered");
  assert.deepEqual(a.silencedBy, ["sil-42"]);
  assert.equal(out.summary.byStatus.silenced, 1);
});

test("silencedBy is attached only when it explains the status", () => {
  const out = shapeGroups([group([alert()])]);
  assert.equal("silencedBy" in out.groups[0].alerts[0], false);
});

test("summary counts by status and severity over every group", () => {
  const out = shapeGroups([
    group([
      alert({ fingerprint: "a" }),
      alert({ fingerprint: "b", labels: { alertname: "X", severity: "warning" } }),
    ]),
    group(
      [alert({ fingerprint: "c", status: { silencedBy: ["s"] }, labels: { alertname: "Y", severity: "warning" } })],
      { labels: { alertname: "Y" } }
    ),
  ]);
  assert.equal(out.summary.groups, 2);
  assert.equal(out.summary.alerts, 3);
  assert.deepEqual(out.summary.byStatus, { active: 2, silenced: 1 });
  assert.deepEqual(out.summary.bySeverity, { critical: 1, warning: 2 });
});

test("an alert with no severity label is counted, not dropped", () => {
  const out = shapeGroups([group([alert({ labels: { alertname: "NodeDown" } })])]);
  assert.equal(out.summary.alerts, 1);
  assert.equal(out.summary.bySeverity.none, 1);
});

// One alert routed to two receivers appears in two groups. Counting it twice would inflate
// the blast radius the agent reports back to on-call.
test("the summary dedups an alert that appears in more than one group", () => {
  const out = shapeGroups([
    group([alert({ fingerprint: "same" })]),
    group([alert({ fingerprint: "same" })], { receiver: { name: "pagerduty" } }),
  ]);
  assert.equal(out.summary.alerts, 1);
  assert.deepEqual(out.summary.byStatus, { active: 1 });
  assert.equal(out.groups.length, 2, "both routes stay visible in the detail");
});

// The k8s_cluster_health lesson: a cap that also trims the counts turns a partial answer into
// one that reads as complete, and "nothing else is firing" is exactly the wrong thing to get
// wrong. Counts stay complete; the detail says how much it left out.
test("capping the detail never caps the counts, and the omission is stated", () => {
  const many = Array.from({ length: 10 }, (_, i) => alert({ fingerprint: `f${i}` }));
  const out = shapeGroups([group(many)], 4);
  assert.equal(out.summary.alerts, 10, "the count must survive the cap");
  assert.deepEqual(out.summary.byStatus, { active: 10 });
  assert.equal(out.groups[0].alerts.length, 4);
  assert.equal(out.omitted, 6);
});

test("the cap is a budget across groups, and omitted is absent when nothing was dropped", () => {
  const out = shapeGroups([group([alert({ fingerprint: "a" }), alert({ fingerprint: "b" })]), group([alert({ fingerprint: "c" })])], 2);
  assert.equal(out.groups.length, 1, "a group that gets no budget is dropped whole, not emptied");
  assert.equal(out.groups[0].alerts.length, 2);
  assert.equal(out.omitted, 1);

  const small = shapeGroups([group([alert()])]);
  assert.equal("omitted" in small, false);
  assert.ok(MAX_DETAIL_ALERTS > 1);
});

test("junk from upstream shapes into an empty answer instead of throwing", () => {
  for (const junk of [null, undefined, {}, "", 7, [null], [{ alerts: "nope" }]]) {
    const out = shapeGroups(junk);
    assert.equal(typeof out.summary.alerts, "number");
    assert.ok(Array.isArray(out.groups));
  }
  assert.equal(shapeGroups([{ alerts: [{}] }]).summary.alerts, 1, "a label-less alert still counts");
});
