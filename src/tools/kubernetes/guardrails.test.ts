import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNamespaceAllowed, assertScaleAllowed, gitOpsVerdict } from "./guardrails.js";

test("protected namespaces are blocked even when allowlisted", () => {
  for (const ns of ["kube-system", "kube-public", "kube-node-lease", "flux-system"]) {
    assert.throws(() => assertNamespaceAllowed(ns, [ns]), /protected and can never/);
  }
});

test("empty allowlist blocks everything with an explicit message", () => {
  assert.throws(() => assertNamespaceAllowed("payment", []), /ALLOWED_REMEDIATION_NAMESPACES is empty/);
});

test("namespaces outside the allowlist are blocked", () => {
  assert.throws(() => assertNamespaceAllowed("orders", ["payment"]), /not in ALLOWED_REMEDIATION_NAMESPACES/);
});

test("allowlisted namespace passes", () => {
  assert.doesNotThrow(() => assertNamespaceAllowed("payment", ["payment", "orders"]));
});

test("scale-to-zero is always refused", () => {
  assert.throws(() => assertScaleAllowed(3, 0, 100), /Scaling to zero is blocked/);
});

test("scale delta beyond MAX_SCALE_DELTA is refused; within passes", () => {
  assert.throws(() => assertScaleAllowed(2, 10, 5), /exceeds MAX_SCALE_DELTA \(5\)/);
  assert.doesNotThrow(() => assertScaleAllowed(2, 6, 5));
  assert.doesNotThrow(() => assertScaleAllowed(6, 2, 5)); // scale down within delta
});

test("gitOpsVerdict: Flux HelmRelease is PR-eligible and carries the HelmRelease identity", () => {
  const v = gitOpsVerdict({ "helm.toolkit.fluxcd.io/name": "auth", "helm.toolkit.fluxcd.io/namespace": "dev-auth" }, "deployment `ns/app`");
  assert.equal(v.managed, true);
  assert.ok(v.managed && v.prEligible && v.source === "flux-helmrelease");
  assert.deepEqual(v.managed ? v.helmRelease : null, { name: "auth", namespace: "dev-auth" });
  assert.match(v.managed ? v.refuseMessage : "", /Pull Request/);
});

test("gitOpsVerdict: Kustomize and plain Helm are managed but NOT PR-eligible", () => {
  const ks = gitOpsVerdict({ "kustomize.toolkit.fluxcd.io/name": "apps", "kustomize.toolkit.fluxcd.io/namespace": "flux-system" }, "deployment `ns/app`");
  assert.ok(ks.managed && !ks.prEligible && ks.source === "flux-kustomization");
  assert.match(ks.managed ? ks.refuseMessage : "", /Flux Kustomization `flux-system\/apps`/);
  const helm = gitOpsVerdict({ "app.kubernetes.io/managed-by": "Helm" }, "deployment `ns/app`");
  assert.ok(helm.managed && !helm.prEligible && helm.source === "helm");
  assert.match(helm.managed ? helm.refuseMessage : "", /helm upgrade/);
});

test("gitOpsVerdict: unmanaged workloads (and missing labels) are not managed", () => {
  assert.equal(gitOpsVerdict({ app: "plain" }, "deployment `ns/app`").managed, false);
  assert.equal(gitOpsVerdict(undefined, "deployment `ns/app`").managed, false);
  assert.equal(gitOpsVerdict({ "app.kubernetes.io/managed-by": "kubectl" }, "deployment `ns/app`").managed, false);
});
