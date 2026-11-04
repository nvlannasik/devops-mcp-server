import { test } from "node:test";
import assert from "node:assert/strict";
import { k8s } from "../client.js";
import { cordonNode, uncordonNode, drainNode } from "./remediation.js";
import writeTools from "../write.js";

// A fake CoreV1Api: nodes, the pods on them, and what the handlers asked of it.
type FakeNode = { name: string; labels?: Record<string, string>; unschedulable?: boolean; taints?: Array<{ effect: string }> };
const fake = {
  nodes: [] as FakeNode[],
  pods: [] as unknown[],
  patches: [] as Array<{ name: string; body: unknown }>,
  evictions: [] as Array<{ ns: string; name: string; dryRun?: string[] }>,
  blocked: new Set<string>(),
  node: (n: FakeNode) => ({ metadata: { name: n.name, labels: n.labels ?? {} }, spec: { unschedulable: n.unschedulable, taints: n.taints } }),
  readNode: async ({ name }: { name: string }) => {
    const n = fake.nodes.find((x) => x.name === name);
    if (!n) throw Object.assign(new Error("not found"), { code: 404 });
    return fake.node(n);
  },
  listNode: async () => ({ items: fake.nodes.map(fake.node) }),
  patchNode: async ({ name, body }: { name: string; body: unknown }) => {
    fake.patches.push({ name, body });
    return {};
  },
  listPodForAllNamespaces: async () => ({ items: fake.pods }),
  createNamespacedPodEviction: async ({ name, namespace, body }: { name: string; namespace: string; body: { deleteOptions?: { dryRun?: string[] } } }) => {
    if (fake.blocked.has(`${namespace}/${name}`)) throw Object.assign(new Error("Too Many Requests"), { code: 429 });
    fake.evictions.push({ ns: namespace, name, dryRun: body?.deleteOptions?.dryRun });
    return {};
  },
};
k8s.KubeConfig.prototype.loadFromFile = function () {};
k8s.KubeConfig.prototype.loadFromCluster = function () {};
k8s.KubeConfig.prototype.makeApiClient = (() => fake) as never;

const reset = (nodes: FakeNode[], pods: unknown[] = []) => {
  fake.nodes = nodes;
  fake.pods = pods;
  fake.patches = [];
  fake.evictions = [];
  fake.blocked = new Set();
};
const pod = (ns: string, name: string, extra: { owner?: string; mirror?: boolean; phase?: string } = {}) => ({
  metadata: {
    namespace: ns,
    name,
    ownerReferences: extra.owner ? [{ kind: extra.owner, name: "x", controller: true }] : [],
    annotations: extra.mirror ? { "kubernetes.io/config.mirror": "abc" } : {},
  },
  status: { phase: extra.phase ?? "Running" },
});
const CP = { "node-role.kubernetes.io/control-plane": "true" };

test("cordon refuses a control-plane node", async () => {
  reset([{ name: "master", labels: CP }, { name: "worker1" }, { name: "worker2" }]);
  await assert.rejects(cordonNode({ node: "master" }), /control-plane/);
  assert.equal(fake.patches.length, 0);
});

test("cordon refuses the last schedulable node", async () => {
  reset([{ name: "master1", taints: [{ effect: "NoSchedule" }] }, { name: "worker1" }]);
  await assert.rejects(cordonNode({ node: "worker1" }), /last schedulable/);
});

test("cordon dry run patches nothing; a real one sets unschedulable", async () => {
  reset([{ name: "worker1" }, { name: "worker2" }]);
  const dry = (await cordonNode({ node: "worker1", dry_run: true })) as Record<string, unknown>;
  assert.equal(dry.dryRun, true);
  assert.equal(fake.patches.length, 0);
  await cordonNode({ node: "worker1" });
  assert.deepEqual(fake.patches, [{ name: "worker1", body: { spec: { unschedulable: true } } }]);
});

test("uncordon refuses a node that is already schedulable; patches a cordoned one", async () => {
  reset([{ name: "worker1" }, { name: "worker2", unschedulable: true }]);
  await assert.rejects(uncordonNode({ node: "worker1" }), /already schedulable/);
  await uncordonNode({ node: "worker2" });
  assert.deepEqual(fake.patches, [{ name: "worker2", body: { spec: { unschedulable: false } } }]);
});

test("drain skips DaemonSet, mirror and completed pods, and evicts the rest", async () => {
  reset(
    [{ name: "worker1" }, { name: "worker2" }],
    [
      pod("apps", "web-1", { owner: "ReplicaSet" }),
      pod("kube-system", "fluentbit-x", { owner: "DaemonSet" }),
      pod("kube-system", "static-y", { mirror: true }),
      pod("apps", "job-z", { owner: "Job", phase: "Succeeded" }),
    ]
  );
  const out = (await drainNode({ node: "worker1" })) as { evicted: string[]; skipped: string[]; blocked: string[] };
  assert.deepEqual(out.evicted, ["apps/web-1"]);
  assert.deepEqual(out.skipped.sort(), ["apps/job-z", "kube-system/fluentbit-x", "kube-system/static-y"]);
  assert.deepEqual(fake.patches, [{ name: "worker1", body: { spec: { unschedulable: true } } }]);
});

test("drain reports PDB-blocked pods instead of failing", async () => {
  reset([{ name: "worker1" }, { name: "worker2" }], [pod("apps", "db-0", { owner: "StatefulSet" }), pod("apps", "web-1", { owner: "ReplicaSet" })]);
  fake.blocked.add("apps/db-0");
  const out = (await drainNode({ node: "worker1" })) as { evicted: string[]; blocked: string[] };
  assert.deepEqual(out.blocked, ["apps/db-0"]);
  assert.deepEqual(out.evicted, ["apps/web-1"]);
});

test("drain dry run sends evictions with dryRun [All] and cordons nothing", async () => {
  reset([{ name: "worker1" }, { name: "worker2" }], [pod("apps", "web-1", { owner: "ReplicaSet" })]);
  await drainNode({ node: "worker1", dry_run: true });
  assert.equal(fake.patches.length, 0);
  assert.deepEqual(fake.evictions, [{ ns: "apps", name: "web-1", dryRun: ["All"] }]);
});

test("write tools list the three node tools with [WRITE] descriptions", () => {
  for (const name of ["k8s_cordon", "k8s_uncordon", "k8s_drain"]) {
    const t = writeTools.find((x) => x.name === name);
    assert.ok(t, name);
    assert.match(t!.description, /^\[WRITE\]/);
  }
});
