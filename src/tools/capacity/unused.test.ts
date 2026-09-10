import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeUnused, collectRefs, type UnusedSnapshot } from "./unused.js";

const empty: UnusedSnapshot = {
  podSpecs: [],
  configMaps: [],
  secrets: [],
  pvcs: [],
  serviceAccounts: [],
  services: [],
  workloads: [],
  ingressSecrets: [],
};
const shape = (over: Partial<UnusedSnapshot>) =>
  shapeUnused({ ...empty, ...over }, { namespaces: 1, complete: true });

const found = (out: ReturnType<typeof shape>, kind: string) =>
  out.findings.filter((f) => f.kind === kind).map((f) => f.name);

test("a ConfigMap referenced only by a scaled-to-zero Deployment's template is NOT unused", () => {
  // The whole point of reading templates and not just pods: no pod exists to hold this
  // reference, and reporting it would be a delete recommendation for live config.
  const out = shape({
    podSpecs: [{ namespace: "app", spec: { volumes: [{ configMap: { name: "app-config" } }] } }],
    configMaps: [{ namespace: "app", name: "app-config" }],
    workloads: [{ kind: "Deployment", namespace: "app", name: "api", replicas: 0 }],
  });
  assert.deepEqual(found(out, "ConfigMap"), []);
  assert.deepEqual(found(out, "Deployment"), ["api"]); // still reported as idle
});

test("references are found through envFrom, projected volumes and imagePullSecrets", () => {
  const refs = collectRefs([
    {
      namespace: "app",
      spec: {
        imagePullSecrets: [{ name: "regcred" }],
        volumes: [{ projected: { sources: [{ configMap: { name: "ca" } }, { secret: { name: "tok" } }] } }],
        containers: [
          { envFrom: [{ configMapRef: { name: "env-cm" } }], env: [{ valueFrom: { secretKeyRef: { name: "db-pw" } } }] },
        ],
      },
    },
  ]);
  assert.deepEqual([...refs.configMaps].sort(), ["app/ca", "app/env-cm"]);
  assert.deepEqual([...refs.secrets].sort(), ["app/db-pw", "app/regcred", "app/tok"]);
});

test("managed objects are skipped: kube-root-ca.crt, Helm release state, SA token, default SA", () => {
  const out = shape({
    configMaps: [{ namespace: "app", name: "kube-root-ca.crt" }],
    secrets: [
      { namespace: "app", name: "sh.helm.release.v1.api.v3", type: "helm.sh/release.v1" },
      { namespace: "app", name: "api-token-x", type: "kubernetes.io/service-account-token" },
      { namespace: "app", name: "stale-key", type: "Opaque" },
    ],
    serviceAccounts: [{ namespace: "app", name: "default" }],
  });
  assert.deepEqual(found(out, "ConfigMap"), []);
  assert.deepEqual(found(out, "Secret"), ["stale-key"]);
  assert.deepEqual(found(out, "ServiceAccount"), []);
});

test("a Secret kept alive by a ServiceAccount or an Ingress TLS block is not unused", () => {
  const out = shape({
    secrets: [
      { namespace: "app", name: "regcred", type: "Opaque" },
      { namespace: "app", name: "tls-cert", type: "kubernetes.io/tls" },
    ],
    serviceAccounts: [{ namespace: "app", name: "runner", imagePullSecrets: ["regcred"] }],
    podSpecs: [{ namespace: "app", spec: { serviceAccountName: "runner" } }],
    ingressSecrets: ["app/tls-cert"],
  });
  assert.deepEqual(found(out, "Secret"), []);
  assert.deepEqual(found(out, "ServiceAccount"), []);
});

test("ExternalName services and default/kubernetes never count as endpoint-less", () => {
  const out = shape({
    services: [
      { namespace: "app", name: "db-alias", type: "ExternalName", addresses: 0 },
      { namespace: "default", name: "kubernetes", type: "ClusterIP", addresses: 0 },
      { namespace: "app", name: "orders", type: "ClusterIP", addresses: 0 },
      { namespace: "app", name: "cart", type: "ClusterIP", addresses: 3 },
    ],
  });
  assert.deepEqual(found(out, "Service"), ["orders"]);
});

test("an incomplete scan says so in the note instead of reporting a clean cluster", () => {
  const out = shapeUnused(empty, { namespaces: 4, complete: false });
  assert.equal(out.scanned.complete, false);
  assert.match(out.note, /SCAN INCOMPLETE/);
});
