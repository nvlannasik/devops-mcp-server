import { ValidationError } from "../../utils/errors/index.js";

// Server-side namespace guardrails for write tools. Enforced HERE (the MCP server holds
// the cluster credentials) — the agent's own checks are UX only and must not be trusted.
// The last line of defense below this is the ServiceAccount RBAC.

// May never be remediated, regardless of the allowlist.
const ALWAYS_BLOCKED = new Set(["kube-system", "kube-public", "kube-node-lease", "flux-system"]);

// Blast-radius limit for k8s_scale: bounded delta, and scale-to-zero is always blocked
// (that's an outage, not a remediation).
/**
 * `quarantine` is the ONE way past the scale-to-zero block, and it is opt-in at the call site
 * rather than inferred, so "take this workload offline" can never be the accidental reading of
 * a replica number.
 *
 * Why the exception exists: removing an unused workload is irreversible against a cluster with
 * no backups, while scaling it to zero is one action to undo. A wrong quarantine costs a
 * scale-back; a wrong delete costs a restore nobody can perform. So the destructive answer to
 * "this looks unused" is the reversible one.
 *
 * What it does NOT relax: the namespace allowlist, the dry-run, the GitOps verdict (a
 * Flux-managed workload still routes to a PR rather than a patch Flux would revert), and the
 * human approval click. And the agent may only ask for it against a workload a
 * `k8s_recommend_resources` run in the same thread listed under `idleWorkloads` — this server
 * cannot check that, which is exactly why the flag is explicit and shows up in the card.
 */
export function assertScaleAllowed(
  current: number,
  target: number,
  maxDelta: number,
  opts: { quarantine?: boolean } = {}
): void {
  if (target < 0 || !Number.isInteger(target)) {
    throw new ValidationError(`Replica target ${target} is not a non-negative whole number`);
  }
  if (target === 0 && !opts.quarantine) {
    throw new ValidationError(
      "Scaling to zero is blocked — that is an outage, not a remediation. It is allowed only as a " +
        "reversible quarantine of a workload measured idle (k8s_recommend_resources -> idleWorkloads), " +
        "and then only with quarantine=true."
    );
  }
  if (target === 0 && current === 0) {
    throw new ValidationError(`${current} replicas already — nothing to quarantine`);
  }
  const delta = Math.abs(target - current);
  if (delta > maxDelta) {
    throw new ValidationError(
      `Replica change of ${delta} (${current} → ${target}) exceeds MAX_SCALE_DELTA (${maxDelta})`
    );
  }
}

// GitOps ownership verdict for the SPEC-MUTATING actions (set_image / set_resources /
// scale). Flux reverts direct spec changes on its next reconcile (~minutes), so a direct
// patch is a lie. Only Flux HelmRelease-managed workloads are eligible for the PR flow (v2,
// DESIGN_gitops_pr_remediation.md) — the change goes to the HelmRelease's spec.values in
// Git. Kustomize (raw-manifest, later phase) and plain Helm (not git-backed) are refused.
// rollout_restart / delete_pod are exempt (reconcile-safe) and never call this.
export type GitOpsVerdict =
  | { managed: false }
  | {
      managed: true;
      prEligible: boolean; // true only for flux-helmrelease (the v2 PR-flow target)
      source: "flux-helmrelease" | "flux-kustomization" | "helm";
      helmRelease?: { name: string; namespace: string };
      refuseMessage: string; // human sentence for the execute/refuse path
    };

export function gitOpsVerdict(labels: Record<string, string> | undefined, target: string): GitOpsVerdict {
  const l = labels ?? {};
  const hrName = l["helm.toolkit.fluxcd.io/name"];
  if (hrName) {
    const namespace = l["helm.toolkit.fluxcd.io/namespace"] ?? "";
    return {
      managed: true,
      prEligible: true,
      source: "flux-helmrelease",
      helmRelease: { name: hrName, namespace },
      refuseMessage: `${target} is managed by Flux HelmRelease \`${namespace}/${hrName}\` — a direct change would be reverted on the next Flux reconcile. It must be applied via a Pull Request to the GitOps repository (rollout_restart is still allowed).`,
    };
  }
  const ksName = l["kustomize.toolkit.fluxcd.io/name"];
  if (ksName) {
    const namespace = l["kustomize.toolkit.fluxcd.io/namespace"] ?? "";
    return {
      managed: true,
      prEligible: false, // raw-manifest PR flow is a later phase (§11)
      source: "flux-kustomization",
      refuseMessage: `${target} is managed by Flux Kustomization \`${namespace}/${ksName}\` — a direct change would be reverted on the next Flux reconcile. Change it in the GitOps repository instead (rollout_restart is still allowed).`,
    };
  }
  if (l["app.kubernetes.io/managed-by"] === "Helm") {
    return {
      managed: true,
      prEligible: false, // plain Helm is not git-backed — no repo to PR against
      source: "helm",
      refuseMessage: `${target} is managed by Helm — a direct change would be lost on the next helm upgrade. Change the chart values instead (rollout_restart is still allowed).`,
    };
  }
  return { managed: false };
}

export function assertNamespaceAllowed(namespace: string, allowlist: string[]): void {
  if (ALWAYS_BLOCKED.has(namespace)) {
    throw new ValidationError(`Namespace "${namespace}" is protected and can never be targeted by write tools`);
  }
  if (!allowlist.includes(namespace)) {
    throw new ValidationError(
      allowlist.length === 0
        ? "Write tools are enabled but ALLOWED_REMEDIATION_NAMESPACES is empty — every namespace is blocked until namespaces are explicitly allowed"
        : `Namespace "${namespace}" is not in ALLOWED_REMEDIATION_NAMESPACES (${allowlist.join(", ")})`
    );
  }
}
