import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeInventory } from "./inventory.js";

const meta = (ns: string, name: string, labels: Record<string, string> = {}) => ({ metadata: { namespace: ns, name, labels } });
const base = {
  namespaces: ["sample-apps", "kube-system", "empty"],
  deployments: [
    { ...meta("sample-apps", "storefront", { "helm.toolkit.fluxcd.io/name": "storefront", "helm.toolkit.fluxcd.io/namespace": "flux-app", "helm.sh/chart": "storefront-0.3.1" }),
      spec: { replicas: 2, template: { spec: { containers: [{ name: "web", image: "ghcr.io/x/storefront:1.4.2", env: [{ name: "SECRET", value: "s3cret" }] }] } } },
      status: { readyReplicas: 1 } },
    { ...meta("kube-system", "coredns"), spec: { replicas: 1, template: { spec: { containers: [{ name: "c", image: "coredns:1.11" }] } } }, status: { readyReplicas: 1 } },
  ],
  statefulsets: [
    { ...meta("sample-apps", "db", { "kustomize.toolkit.fluxcd.io/name": "apps", "kustomize.toolkit.fluxcd.io/namespace": "flux-system" }),
      spec: { replicas: 1, template: { spec: { containers: [{ name: "pg", image: "postgres:16" }] } } }, status: { readyReplicas: 1 } },
  ],
  daemonsets: [],
  cronjobs: [{ ...meta("sample-apps", "nightly", { "app.kubernetes.io/managed-by": "Helm", "helm.sh/chart": "jobs-1.0.0" }),
    spec: { schedule: "0 2 * * *", jobTemplate: { spec: { template: { spec: { containers: [{ name: "j", image: "busybox:1.36" }] } } } } } }],
  services: [{ ...meta("sample-apps", "storefront"), spec: { type: "ClusterIP", ports: [{ port: 80, protocol: "TCP", targetPort: 3000 }] } }],
  ingresses: [{ ...meta("sample-apps", "storefront"), spec: { rules: [{ host: "shop.example.com" }] } }],
  kustomizations: [{ metadata: { name: "apps", namespace: "flux-system" }, spec: { path: "./apps/dev" } }] as Array<{ metadata: { name: string; namespace: string }; spec?: { path?: string } }> | null,
  complete: true,
};

test("every owner type is read with the GitOps guard's own reader", () => {
  const ns = shapeInventory(base).namespaces.find((n) => n.name === "sample-apps")!;
  const by = Object.fromEntries(ns.workloads.map((w) => [w.name, w.managedBy]));
  assert.deepEqual(by.storefront, { type: "helmrelease", name: "storefront", namespace: "flux-app", chart: "storefront-0.3.1" });
  assert.deepEqual(by.db, { type: "kustomization", name: "apps", namespace: "flux-system", path: "./apps/dev" });
  assert.deepEqual(by.nightly, { type: "helm", chart: "jobs-1.0.0" });
  const core = shapeInventory(base).namespaces.find((n) => n.name === "kube-system")!;
  assert.deepEqual(core.workloads[0]!.managedBy, { type: "unmanaged" });
  assert.equal(core.system, true);
});

test("counts, images, ports, hosts and schedules — and nothing from env", () => {
  const out = shapeInventory(base);
  const ns = out.namespaces.find((n) => n.name === "sample-apps")!;
  const sf = ns.workloads.find((w) => w.name === "storefront")!;
  assert.deepEqual([sf.kind, sf.ready, sf.desired, sf.images], ["Deployment", 1, 2, ["ghcr.io/x/storefront:1.4.2"]]);
  assert.deepEqual(ns.services, [{ name: "storefront", type: "ClusterIP", ports: ["80/TCP→3000"] }]);
  assert.deepEqual(ns.ingresses, [{ name: "storefront", hosts: ["shop.example.com"] }]);
  assert.equal(ns.workloads.find((w) => w.name === "nightly")!.schedule, "0 2 * * *");
  assert.doesNotMatch(JSON.stringify(out), /s3cret|SECRET/);
});

test("a namespace with nothing deployed is listed with empty arrays, not dropped", () => {
  const empty = shapeInventory(base).namespaces.find((n) => n.name === "empty")!;
  assert.deepEqual([empty.workloads, empty.services, empty.ingresses], [[], [], []]);
});

test("unreadable Kustomizations leave the path absent, never guessed", () => {
  const ns = shapeInventory({ ...base, kustomizations: null }).namespaces.find((n) => n.name === "sample-apps")!;
  assert.deepEqual(ns.workloads.find((w) => w.name === "db")!.managedBy, { type: "kustomization", name: "apps", namespace: "flux-system" });
});

test("system namespaces sort last, and complete:false survives to the caller", () => {
  const out = shapeInventory({ ...base, complete: false });
  assert.deepEqual(out.scanned, { namespaces: 3, complete: false });
  assert.equal(out.namespaces.at(-1)!.name, "kube-system");
});
