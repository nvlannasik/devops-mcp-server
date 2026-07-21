import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNamespaceAllowed, assertScaleAllowed, assertNotGitOpsManaged } from "./guardrails.js";

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

test("GitOps guard refuses Flux-managed workloads with the owning object named", () => {
  assert.throws(
    () => assertNotGitOpsManaged({ "kustomize.toolkit.fluxcd.io/name": "apps", "kustomize.toolkit.fluxcd.io/namespace": "flux-system" }, "deployment ns/app"),
    /Flux Kustomization "flux-system\/apps".*reverted/
  );
  assert.throws(
    () => assertNotGitOpsManaged({ "helm.toolkit.fluxcd.io/name": "auth", "helm.toolkit.fluxcd.io/namespace": "dev-auth" }, "deployment ns/app"),
    /Flux HelmRelease "dev-auth\/auth"/
  );
});

test("GitOps guard refuses Helm-managed workloads", () => {
  assert.throws(() => assertNotGitOpsManaged({ "app.kubernetes.io/managed-by": "Helm" }, "deployment ns/app"), /managed by Helm.*helm upgrade/);
});

test("GitOps guard passes unmanaged workloads (and missing labels)", () => {
  assertNotGitOpsManaged({ app: "plain" }, "deployment ns/app");
  assertNotGitOpsManaged(undefined, "deployment ns/app");
  assertNotGitOpsManaged({ "app.kubernetes.io/managed-by": "kubectl" }, "deployment ns/app");
});
