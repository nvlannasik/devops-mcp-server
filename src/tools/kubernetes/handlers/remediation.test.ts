import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResourcesPatch, findContainer, findRecreatingOwner, resourceChanges, orphanRefusal, restorableManifest, type OrphanCheck } from "./remediation.js";

test("resourceChanges maps provided fields to {field,from,to}, from current or (unset)", () => {
  const cur = { requests: { cpu: "100m" }, limits: { memory: "512Mi" } };
  const changes = resourceChanges(cur, { cpu_request: "250m", memory_limit: "1Gi", cpu_limit: "1" });
  assert.deepEqual(changes, [
    { field: "requests.cpu", from: "100m", to: "250m" },
    { field: "limits.cpu", from: "(unset)", to: "1" },
    { field: "limits.memory", from: "512Mi", to: "1Gi" },
  ]);
  assert.deepEqual(resourceChanges(undefined, { memory_request: "256Mi" }), [{ field: "requests.memory", from: "(unset)", to: "256Mi" }]);
});

const workload = (...names: string[]) => ({
  spec: { template: { spec: { containers: names.map((name) => ({ name, image: `${name}:v1` })) } } },
});

test("findContainer auto-resolves when container omitted and workload has one container", () => {
  assert.equal(findContainer(workload("auth"), undefined, "deployment ns/app").name, "auth");
});

test("findContainer refuses omitted container on multi-container workloads, listing names", () => {
  assert.throws(() => findContainer(workload("auth", "sidecar"), undefined, "deployment ns/app"), /auth, sidecar.*specify/);
});

test("findContainer rejects a wrong name, listing what exists", () => {
  assert.throws(() => findContainer(workload("auth"), "dev-auth-svc-be", "deployment ns/app"), /not found.*has: auth/);
});

test("only provided resource values enter the patch", () => {
  const p = buildResourcesPatch("api", { memory_limit: "1Gi" });
  assert.deepEqual(p, {
    spec: { template: { spec: { containers: [{ name: "api", resources: { limits: { memory: "1Gi" } } }] } } },
  });
});

test("requests and limits are grouped correctly", () => {
  const p = buildResourcesPatch("api", { cpu_request: "250m", memory_request: "256Mi", memory_limit: "1Gi" });
  const resources = p.spec.template.spec.containers[0].resources;
  assert.deepEqual(resources, { requests: { cpu: "250m", memory: "256Mi" }, limits: { memory: "1Gi" } });
});

test("findRecreatingOwner: controller-owned pods resolve, naked/Job pods do not", () => {
  const rs = { ownerReferences: [{ kind: "ReplicaSet", name: "app-5ccd7547bb", controller: true }] };
  assert.equal(findRecreatingOwner(rs)?.name, "app-5ccd7547bb");
  assert.equal(findRecreatingOwner({ ownerReferences: [] }), null); // naked pod
  assert.equal(findRecreatingOwner(undefined), null);
  assert.equal(findRecreatingOwner({ ownerReferences: [{ kind: "Job", name: "backup", controller: true }] }), null);
  // non-controller reference doesn't count
  assert.equal(findRecreatingOwner({ ownerReferences: [{ kind: "ReplicaSet", name: "x", controller: false }] }), null);
});

// ── k8s_delete_orphan ────────────────────────────────────────────────────────
// Every refusal below is a live object that survives because the check was right. This is the
// one tool in the server whose mistake cannot be undone from the cluster, so the guards get
// tested one at a time rather than as a bundle.

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 16); // 2026-09-16
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

const orphan = (over: Partial<OrphanCheck> = {}): OrphanCheck => ({
  kind: "configmap",
  namespace: "sample-apps",
  name: "leftover-config",
  managedBy: "none",
  createdAt: daysAgo(200),
  ...over,
});

test("an old, undeclared, unowned object is the one case that passes", () => {
  assert.equal(orphanRefusal(orphan(), NOW), null);
});

// The inversion that shapes this whole tool: a declared object cannot be removed here at all.
// Flux restores it, and its being declared is evidence the finding is wrong.
test("anything Flux or Helm declares is refused, and told where removal belongs", () => {
  for (const managedBy of ["flux", "helm"] as const) {
    const refusal = orphanRefusal(orphan({ managedBy }), NOW);
    assert.match(refusal!, new RegExp(`declared by ${managedBy}`));
    assert.match(refusal!, /undone on the next reconcile/);
    assert.match(refusal!, /GitOps repo/);
    assert.match(refusal!, /evidence the "unused" finding is wrong/);
  }
});

test("an ownerReference is refused — the garbage collector already owns this", () => {
  assert.match(orphanRefusal(orphan({ owner: "Certificate/api-tls" }), NOW)!, /owned by Certificate\/api-tls/);
});

// New is not abandoned. Somebody is probably still building the thing that will reference it.
test("an object younger than the minimum age is refused, and told its age", () => {
  assert.match(orphanRefusal(orphan({ createdAt: daysAgo(3) }), NOW)!, /is 3 day\(s\) old/);
  assert.match(orphanRefusal(orphan({ createdAt: daysAgo(13) }), NOW)!, /not abandoned, it is new/);
  assert.equal(orphanRefusal(orphan({ createdAt: daysAgo(14) }), NOW), null, "the boundary itself must pass");
});

// Fails closed: no timestamp means the only abandonment evidence available is missing.
test("an object with no creationTimestamp is refused rather than assumed old", () => {
  assert.match(orphanRefusal(orphan({ createdAt: undefined }), NOW)!, /age cannot be established/);
});

test("a workload still running replicas is refused and steered to the quarantine first", () => {
  const dep = orphan({ kind: "deployment", name: "orders-api", replicas: 2 });
  assert.match(orphanRefusal(dep, NOW)!, /still runs 2 replica\(s\)/);
  assert.match(orphanRefusal(dep, NOW)!, /quarantine it to zero/);
  assert.equal(orphanRefusal(orphan({ kind: "deployment", name: "orders-api", replicas: 0 }), NOW), null);
});

// It is unreferenced by construction, it is ancient, and it is the API server.
test("the default/kubernetes Service can never be deleted, however old and unreferenced", () => {
  const svc = orphan({ kind: "service", namespace: "default", name: "kubernetes", createdAt: daysAgo(400) });
  assert.match(orphanRefusal(svc, NOW)!, /takes the cluster with it/);
});

// ── The backup ───────────────────────────────────────────────────────────────
// "The backup restores what we deleted" is the single claim that makes this tool acceptable,
// and it is the one easiest to break by accident: one leftover resourceVersion and every
// restore fails with a conflict at the worst possible moment.

test("the captured manifest is stripped of everything that would reject a re-apply", () => {
  const m = restorableManifest("configmap", {
    metadata: {
      name: "leftover-config", namespace: "sample-apps",
      uid: "0d6c1f9e-0000-4000-8000-000000000000",
      resourceVersion: "84610233", generation: 4,
      creationTimestamp: "2026-02-14T02:11:00Z",
      managedFields: [{ manager: "kubectl-client-side-apply" }],
      annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{...}", "owner": "platform" },
    },
    data: { "app.conf": "timeout=30" },
    status: { something: true },
  });
  const meta = m.metadata as Record<string, unknown>;
  for (const gone of ["uid", "resourceVersion", "generation", "creationTimestamp", "managedFields"]) {
    assert.equal(gone in meta, false, `${gone} survived into the backup`);
  }
  assert.equal("status" in m, false);
  assert.deepEqual(meta.annotations, { owner: "platform" }, "a real annotation was dropped with the noise");
  assert.equal(meta.name, "leftover-config");
  assert.deepEqual(m.data, { "app.conf": "timeout=30" });
  assert.equal(m.apiVersion, "v1");
  assert.equal(m.kind, "ConfigMap");
});

// An allocated ClusterIP belongs to this cluster's allocator, not to the manifest — keeping it
// makes the restore fail with "provided IP is already allocated".
test("a Service backup drops the allocated cluster IPs but keeps the rest of the spec", () => {
  const m = restorableManifest("service", {
    metadata: { name: "orders", namespace: "sample-apps" },
    spec: { clusterIP: "10.43.12.9", clusterIPs: ["10.43.12.9"], selector: { app: "orders" }, ports: [{ port: 80 }] },
  });
  const spec = m.spec as Record<string, unknown>;
  assert.equal("clusterIP" in spec, false);
  assert.equal("clusterIPs" in spec, false);
  assert.deepEqual(spec.selector, { app: "orders" });
  assert.deepEqual(spec.ports, [{ port: 80 }]);
});

test("an annotations block that held only noise is removed, not left empty", () => {
  const m = restorableManifest("configmap", {
    metadata: { name: "x", namespace: "y", annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{...}" } },
  });
  assert.equal("annotations" in (m.metadata as Record<string, unknown>), false);
});

test("a ServiceAccount keeps the fields that are its whole content", () => {
  const m = restorableManifest("serviceaccount", {
    metadata: { name: "deployer", namespace: "sample-apps" },
    secrets: [{ name: "deployer-token" }],
    imagePullSecrets: [{ name: "regcred" }],
  });
  assert.deepEqual(m.secrets, [{ name: "deployer-token" }]);
  assert.deepEqual(m.imagePullSecrets, [{ name: "regcred" }]);
});
