import { z } from "zod";
import { getApi, k8s } from "../../client.js";
import { withUpstream, ValidationError } from "../../../../utils/errors/index.js";
import { assertNamespaceAllowed, gitOpsVerdict } from "../../guardrails.js";
import config from "../../../../config/index.js";
import { KINDS, readWorkload } from "./shared.js";

// ---- flux_reconcile (restore the cluster FROM the GitOps repo) ----

// Flux's HelmRelease API version has moved over releases (v2beta1 → v2beta2 → v2). Read the
// CRD's storage version instead of pinning one and breaking silently on the next upgrade.
async function helmReleaseApiVersion(): Promise<string> {
  const crd = await getApi(k8s.ApiextensionsV1Api).readCustomResourceDefinition({
    name: "helmreleases.helm.toolkit.fluxcd.io",
  });
  const versions = crd.spec.versions ?? [];
  const v = versions.find((x) => x.storage) ?? versions.find((x) => x.served);
  if (!v) throw new ValidationError("the HelmRelease CRD reports no served version — is Flux's helm-controller installed?");
  return v.name;
}

const FluxReconcile = z.object({
  namespace: z.string().min(1), // the WORKLOAD's namespace
  name: z.string().min(1),
  kind: z.enum(KINDS).optional().default("deployment"),
  dry_run: z.boolean().optional(),
});

// The inverse of every other write tool: it introduces no new state, it forces Flux to
// re-apply the state the GitOps repo already declares — the fix when someone changed the
// cluster directly (drift). Restoring declared state is why this one is NOT GitOps-refused.
export const fluxReconcile = (input: unknown) => {
  const { namespace, name, kind, dry_run } = FluxReconcile.parse(input);
  // Guard on the WORKLOAD's namespace, not the HelmRelease's: HelmReleases usually live in
  // flux-system (permanently blocked), while the blast radius of a reconcile is whatever the
  // release manages. The caller never names a HelmRelease — it is derived from the workload's
  // own Flux labels, so this cannot be aimed at an arbitrary release.
  assertNamespaceAllowed(namespace, config.writeTools.allowedNamespaces);

  return withUpstream("kubernetes", `Failed to reconcile ${kind} \`${namespace}/${name}\``, async () => {
    const current = await readWorkload(kind, name, namespace);
    const verdict = gitOpsVerdict(current.metadata?.labels, `${kind} \`${namespace}/${name}\``);
    if (!verdict.managed || verdict.source !== "flux-helmrelease" || !verdict.helmRelease?.name) {
      throw new ValidationError(
        `${kind} \`${namespace}/${name}\` is not managed by a Flux HelmRelease — there is no declared state to reconcile it back to.`
      );
    }
    const hr = verdict.helmRelease;
    if (!hr.namespace) {
      throw new ValidationError(
        `${kind} \`${namespace}/${name}\` carries helm.toolkit.fluxcd.io/name=${hr.name} but no namespace label — cannot locate the HelmRelease.`
      );
    }
    const version = await helmReleaseApiVersion();
    const at = new Date().toISOString();
    // requestedAt alone only re-evaluates the release; drift from a direct kubectl edit is
    // reverted by the forced helm upgrade that forceAt triggers. `flux reconcile helmrelease
    // --force` sets both.
    const body = { metadata: { annotations: { "reconcile.fluxcd.io/requestedAt": at, "reconcile.fluxcd.io/forceAt": at } } };
    await getApi(k8s.CustomObjectsApi).patchNamespacedCustomObject(
      {
        group: "helm.toolkit.fluxcd.io",
        version,
        namespace: hr.namespace,
        plural: "helmreleases",
        name: hr.name,
        body,
        ...(dry_run ? { dryRun: "All" } : {}),
      },
      // CRs do not support strategic-merge — plain merge patch adds the annotations
      k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch)
    );
    return {
      action: "flux_reconcile",
      workload: `${kind}/${namespace}/${name}`,
      helmRelease: `${hr.namespace}/${hr.name}`,
      apiVersion: `helm.toolkit.fluxcd.io/${version}`,
      requestedAt: at,
      dryRun: !!dry_run,
      result: dry_run
        ? "validated — the HelmRelease exists and the reconcile annotation is accepted (nothing was changed)"
        : "reconcile requested — Flux re-applies the GitOps repo's declared state, reverting the in-cluster drift",
    };
  });
};
