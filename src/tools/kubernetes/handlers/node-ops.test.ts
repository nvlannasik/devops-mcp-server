import { test } from "node:test";
import assert from "node:assert/strict";
import { k8s } from "../client.js";
import { cordonNode, uncordonNode, drainNode, nodeMatchesTerms } from "./remediation.js";
import writeTools from "../write.js";

// A fake CoreV1Api: nodes, the pods on them, the PVs, and what the handlers asked of it.
type FakeNode = {
  name: string;
  labels?: Record<string, string>;
  unschedulable?: boolean;
  taints?: Array<{ effect: string }>;
  allocatable?: { cpu: string; memory: string };
};
const fake = {
  nodes: [] as FakeNode[],
  pods: [] as unknown[],
  pvs: [] as unknown[],
  patches: [] as Array<{ name: string; body: unknown }>,
  evictions: [] as Array<{ ns: string; name: string; dryRun?: string[] }>,
  blocked: new Set<string>(),
  node: (n: FakeNode) => ({
    metadata: { name: n.name, labels: { "kubernetes.io/hostname": n.name, ...(n.labels ?? {}) } },
    spec: { unschedulable: n.unschedulable, taints: n.taints },
    status: { allocatable: n.allocatable ?? { cpu: "4", memory: "8Gi" } },
  }),
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
  listPersistentVolume: async () => ({ items: fake.pvs }),
  createNamespacedPodEviction: async ({ name, namespace, body }: { name: string; namespace: string; body: { deleteOptions?: { dryRun?: string[] } } }) => {
    if (fake.blocked.has(`${namespace}/${name}`)) throw Object.assign(new Error("Too Many Requests"), { code: 429 });
    fake.evictions.push({ ns: namespace, name, dryRun: body?.deleteOptions?.dryRun });
    return {};
  },
};
k8s.KubeConfig.prototype.loadFromFile = function () {};
k8s.KubeConfig.prototype.loadFromCluster = function () {};
k8s.KubeConfig.prototype.makeApiClient = (() => fake) as never;

const reset = (nodes: FakeNode[], pods: unknown[] = [], pvs: unknown[] = []) => {
  fake.nodes = nodes;
  fake.pods = pods;
  fake.pvs = pvs;
  fake.patches = [];
  fake.evictions = [];
  fake.blocked = new Set();
};
type PodExtra = { owner?: string; mirror?: boolean; phase?: string; node?: string; claim?: string; ephemeral?: string; cpu?: string; memory?: string };
const pod = (ns: string, name: string, extra: PodExtra = {}) => ({
  metadata: {
    namespace: ns,
    name,
    ownerReferences: extra.owner ? [{ kind: extra.owner, name: "x", controller: true }] : [],
    annotations: extra.mirror ? { "kubernetes.io/config.mirror": "abc" } : {},
  },
  spec: {
    nodeName: extra.node ?? "worker1",
    containers: [{ resources: { requests: { ...(extra.cpu ? { cpu: extra.cpu } : {}), ...(extra.memory ? { memory: extra.memory } : {}) } } }],
    volumes: [
      ...(extra.claim ? [{ name: "data", persistentVolumeClaim: { claimName: extra.claim } }] : []),
      ...(extra.ephemeral ? [{ name: extra.ephemeral, ephemeral: { volumeClaimTemplate: {} } }] : []),
    ],
  },
  status: { phase: extra.phase ?? "Running" },
});
/** A PV bound to ns/claim, its node affinity one requirement — local-path's shape is hostname In [node]. */
const pv = (ns: string, claim: string, key: string, values: string[]) => ({
  spec: {
    claimRef: { namespace: ns, name: claim },
    nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key, operator: "In", values }] }] } },
  },
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

test("drain keeps a pod whose local-path volume lives only on this node, and evicts the rest", async () => {
  reset(
    [{ name: "worker1" }, { name: "worker2" }],
    [pod("postgresql", "postgresql-0", { owner: "StatefulSet", claim: "data-postgresql-0" }), pod("apps", "web-1", { owner: "ReplicaSet" })],
    [pv("postgresql", "data-postgresql-0", "kubernetes.io/hostname", ["worker1"])]
  );
  const out = (await drainNode({ node: "worker1" })) as { evicted: string[]; pinned: Array<{ pod: string; claim: string }>; result: string };
  assert.deepEqual(out.evicted, ["apps/web-1"]);
  assert.deepEqual(out.pinned, [{ pod: "postgresql/postgresql-0", claim: "data-postgresql-0" }]);
  assert.deepEqual(
    fake.evictions.map((e) => e.name),
    ["web-1"]
  );
  assert.match(out.result, /kept on the node because their volume exists only there \(postgresql\/postgresql-0 via PVC data-postgresql-0\)/);
});

test("drain evicts a pod whose volume another schedulable node can also reach", async () => {
  reset(
    [{ name: "worker1", labels: { zone: "a" } }, { name: "worker2", labels: { zone: "a" } }],
    [pod("apps", "db-0", { owner: "StatefulSet", claim: "data-db-0" })],
    [pv("apps", "data-db-0", "zone", ["a"])]
  );
  const out = (await drainNode({ node: "worker1", dry_run: true })) as { evicted: string[]; pinned: unknown[] };
  assert.deepEqual(out.evicted, ["apps/db-0"]);
  assert.deepEqual(out.pinned, []);
});

test("a pinned volume counts only schedulable nodes: a cordoned peer that could mount it does not unpin it", async () => {
  reset(
    [{ name: "worker1", labels: { zone: "a" } }, { name: "worker2", labels: { zone: "a" }, unschedulable: true }, { name: "worker3", labels: { zone: "b" } }],
    [pod("apps", "db-0", { owner: "StatefulSet", claim: "data-db-0" })],
    [pv("apps", "data-db-0", "zone", ["a"])]
  );
  const out = (await drainNode({ node: "worker1", dry_run: true })) as { pinned: Array<{ pod: string }> };
  assert.deepEqual(
    out.pinned.map((x) => x.pod),
    ["apps/db-0"]
  );
});

test("a generic ephemeral volume's claim (<pod>-<volume>) pins its pod too", async () => {
  reset(
    [{ name: "worker1" }, { name: "worker2" }],
    [pod("apps", "cache-0", { owner: "StatefulSet", ephemeral: "scratch" })],
    [pv("apps", "cache-0-scratch", "kubernetes.io/hostname", ["worker1"])]
  );
  const out = (await drainNode({ node: "worker1", dry_run: true })) as { pinned: Array<{ claim: string }>; evicted: string[] };
  assert.deepEqual(out.evicted, []);
  assert.equal(out.pinned[0]?.claim, "cache-0-scratch");
});

test("drain refuses, before cordoning, when the moving requests cannot fit on the other nodes", async () => {
  reset(
    [{ name: "worker1" }, { name: "worker2", allocatable: { cpu: "2", memory: "2Gi" } }],
    [
      pod("apps", "big-1", { owner: "ReplicaSet", memory: "1500Mi", cpu: "200m" }),
      pod("apps", "busy-2", { owner: "ReplicaSet", node: "worker2", memory: "1Gi", cpu: "200m" }),
    ]
  );
  await assert.rejects(drainNode({ node: "worker1" }), /would move 1 pod\(s\) requesting 1\.5Gi memory \/ 200m CPU, but the other schedulable nodes have only 1\.0Gi \/ 1\.80 cores free/);
  await assert.rejects(drainNode({ node: "worker1", dry_run: true }), /would sit Pending/);
  assert.equal(fake.patches.length, 0);
  assert.equal(fake.evictions.length, 0);
});

test("capacity ignores finished pods on the other nodes and pods that stay on this one", async () => {
  reset(
    [{ name: "worker1" }, { name: "worker2", allocatable: { cpu: "2", memory: "2Gi" } }],
    [
      pod("apps", "web-1", { owner: "ReplicaSet", memory: "1Gi" }),
      pod("postgresql", "postgresql-0", { owner: "StatefulSet", claim: "data-postgresql-0", memory: "4Gi" }),
      pod("kube-system", "fluentbit-x", { owner: "DaemonSet", memory: "4Gi" }),
      pod("apps", "job-done", { owner: "Job", node: "worker2", phase: "Succeeded", memory: "2Gi" }),
    ],
    [pv("postgresql", "data-postgresql-0", "kubernetes.io/hostname", ["worker1"])]
  );
  const out = (await drainNode({ node: "worker1", dry_run: true })) as { evicted: string[]; capacity: { moving: { memory: string }; free: { memory: string } } };
  assert.deepEqual(out.evicted, ["apps/web-1"]);
  assert.deepEqual(out.capacity.moving.memory, "1.0Gi");
  assert.deepEqual(out.capacity.free.memory, "2.0Gi");
});

test("node allocatable in Ki (how every real node reports memory) is read, and unreadable allocatable refuses honestly", async () => {
  reset(
    [{ name: "worker1" }, { name: "worker2", allocatable: { cpu: "3400m", memory: "7100476Ki" } }],
    [pod("apps", "web-1", { owner: "ReplicaSet", memory: "1Gi" })]
  );
  const out = (await drainNode({ node: "worker1", dry_run: true })) as { capacity: { free: { memory: string } } };
  assert.equal(out.capacity.free.memory, "6.8Gi");
  reset([{ name: "worker1" }, { name: "worker2", allocatable: { cpu: "2", memory: "lots" } }], [pod("apps", "web-1", { owner: "ReplicaSet" })]);
  await assert.rejects(drainNode({ node: "worker1", dry_run: true }), /cannot read node `worker2`'s allocatable/);
  assert.equal(fake.patches.length, 0);
});

test("an init container larger than the main containers sets the pod's request", async () => {
  const big = pod("apps", "migrate-1", { owner: "ReplicaSet", memory: "100Mi" }) as { spec: { initContainers?: unknown[] } };
  big.spec.initContainers = [{ resources: { requests: { memory: "3Gi" } } }];
  reset([{ name: "worker1" }, { name: "worker2", allocatable: { cpu: "2", memory: "2Gi" } }], [big]);
  await assert.rejects(drainNode({ node: "worker1", dry_run: true }), /requesting 3\.0Gi memory/);
});

test("nodeMatchesTerms follows the API: terms OR, requirements AND, an empty term matches nothing", () => {
  const n = { metadata: { name: "worker2", labels: { zone: "a", arch: "arm64" } } };
  const req = (key: string, operator: string, values?: string[]) => ({ key, operator, values });
  assert.equal(nodeMatchesTerms(n, [{ matchExpressions: [req("zone", "In", ["a"]), req("arch", "In", ["amd64"])] }]), false);
  assert.equal(nodeMatchesTerms(n, [{ matchExpressions: [req("arch", "In", ["amd64"])] }, { matchExpressions: [req("zone", "In", ["a"])] }]), true);
  assert.equal(nodeMatchesTerms(n, [{}]), false);
  assert.equal(nodeMatchesTerms(n, [{ matchExpressions: [req("zone", "NotIn", ["b"]), req("gpu", "DoesNotExist")] }]), true);
  assert.equal(nodeMatchesTerms(n, [{ matchFields: [req("metadata.name", "In", ["worker2"])] }]), true);
  assert.equal(nodeMatchesTerms(n, [{ matchExpressions: [req("zone", "Bogus", ["a"])] }]), false);
});

test("write tools list the three node tools with [WRITE] descriptions", () => {
  for (const name of ["k8s_cordon", "k8s_uncordon", "k8s_drain"]) {
    const t = writeTools.find((x) => x.name === name);
    assert.ok(t, name);
    assert.match(t!.description, /^\[WRITE\]/);
  }
});
