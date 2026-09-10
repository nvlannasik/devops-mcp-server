import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shapeUnused,
  collectRefs,
  collectFindings,
  assembleUnused,
  mentionedNames,
  type UnusedSnapshot,
} from "./unused.js";

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

test("an ownerReference alone keeps an object out of the report — no CR scan needed", () => {
  // The free half of the cross-check: an operator-CREATED object carries one, and Kubernetes'
  // own GC deletes it when the owner goes. Costs no API call.
  const out = shape({
    secrets: [{ namespace: "app", name: "api-tls", type: "kubernetes.io/tls", owner: "Certificate/api-tls" }],
    configMaps: [{ namespace: "app", name: "leftover" }],
  });
  assert.deepEqual(found(out, "Secret"), []);
  assert.deepEqual(found(out, "ConfigMap"), ["leftover"]);
  assert.equal(out.crossCheck, undefined); // not run here
});

test("a name a custom resource mentions is dropped, and the CR that saved it is named", () => {
  const findings = collectFindings({
    ...empty,
    configMaps: [{ namespace: "app", name: "grafana-dashboard" }, { namespace: "app", name: "real-leftover" }],
  });
  const mentions = mentionedNames(
    [{ namespace: "app", source: "grafanadashboards.grafana.integreatly.org/app/home", obj: { spec: { configMapRef: { name: "grafana-dashboard" } } } }],
    new Map([["app", new Set(["grafana-dashboard", "real-leftover"])]])
  );
  const out = assembleUnused(findings, {
    namespaces: 1,
    complete: true,
    checked: {},
    crossCheck: { enabled: true, crdsScanned: 12, crdsUnreadable: [], mentions },
  });
  assert.deepEqual(found(out, "ConfigMap"), ["real-leftover"]);
  assert.equal(out.crossCheck!.suppressedTotal, 1);
  assert.equal(out.crossCheck!.suppressed[0].keptBy, "grafanadashboards.grafana.integreatly.org/app/home");
  assert.match(out.note, /All 12 CRD kinds/);
});

test("a mention only counts inside its own namespace, unless the CR is cluster-scoped", () => {
  const wanted = new Map([["a", new Set(["shared"])], ["b", new Set(["shared"])]]);
  const scoped = mentionedNames([{ namespace: "a", source: "x/a/one", obj: { ref: "shared" } }], wanted);
  assert.deepEqual([...scoped.keys()], ["a/shared"]);

  // A ClusterIssuer can name a Secret in any namespace, so the name is protected everywhere.
  const cluster = mentionedNames([{ source: "clusterissuers.cert-manager.io/ca", obj: { ref: "shared" } }], wanted);
  assert.deepEqual([...cluster.keys()].sort(), ["a/shared", "b/shared"]);
});

test("names are matched in map KEYS too, and managedFields is never walked", () => {
  const wanted = new Map([["app", new Set(["as-key", "buried"])]]);
  const out = mentionedNames(
    [{ namespace: "app", source: "x/app/one", obj: { spec: { "as-key": 1 }, metadata: { managedFields: [{ f: "buried" }] } } }],
    wanted
  );
  assert.deepEqual([...out.keys()], ["app/as-key"]);
});

test("an unreadable CRD downgrades the note instead of claiming a clean cross-check", () => {
  const out = assembleUnused(
    collectFindings({ ...empty, configMaps: [{ namespace: "app", name: "leftover" }] }),
    {
      namespaces: 1,
      complete: true,
      checked: {},
      crossCheck: { enabled: true, crdsScanned: 9, crdsUnreadable: ["volumes.longhorn.io"], mentions: new Map() },
    }
  );
  assert.match(out.note, /could NOT be read \(RBAC\): volumes\.longhorn\.io/);
  assert.ok(!/All 9 CRD kinds/.test(out.note));
});

test("cross-check turned off says so — the list is not a verified one", () => {
  const out = assembleUnused(collectFindings({ ...empty, configMaps: [{ namespace: "app", name: "leftover" }] }), {
    namespaces: 1,
    complete: true,
    checked: {},
    crossCheck: { enabled: false, crdsScanned: 0, crdsUnreadable: [], mentions: new Map() },
  });
  assert.match(out.note, /were NOT cross-checked/);
});

test("cross-check ON with no candidates says there was nothing to check, not that it was off", () => {
  const out = assembleUnused(collectFindings({ ...empty, services: [{ namespace: "app", name: "orders", type: "ClusterIP", addresses: 0 }] }), {
    namespaces: 1,
    complete: true,
    checked: {},
    crossCheck: { enabled: true, crdsScanned: 0, crdsUnreadable: [], mentions: new Map() },
  });
  assert.match(out.note, /nothing\s+left for the custom-resource cross-check to disprove/);
  assert.ok(!/cross_check_crds is off/.test(out.note));
  assert.deepEqual(found(out, "Service"), ["orders"]); // state claim, unaffected
});
