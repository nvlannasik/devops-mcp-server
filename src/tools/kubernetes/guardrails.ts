import { ValidationError } from "../../utils/errors/index.js";

// Server-side namespace guardrails for write tools. Enforced HERE (the MCP server holds
// the cluster credentials) — the agent's own checks are UX only and must not be trusted.
// The last line of defense below this is the ServiceAccount RBAC.

// May never be remediated, regardless of the allowlist.
const ALWAYS_BLOCKED = new Set(["kube-system", "kube-public", "kube-node-lease", "flux-system"]);

// Blast-radius limit for k8s_scale: bounded delta, and scale-to-zero is always blocked
// (that's an outage, not a remediation).
export function assertScaleAllowed(current: number, target: number, maxDelta: number): void {
  if (target < 1) {
    throw new ValidationError("Scaling to zero is blocked — that is an outage, not a remediation");
  }
  const delta = Math.abs(target - current);
  if (delta > maxDelta) {
    throw new ValidationError(
      `Replica change of ${delta} (${current} → ${target}) exceeds MAX_SCALE_DELTA (${maxDelta})`
    );
  }
}

// GitOps guard for the SPEC-MUTATING actions (set_image / set_resources / scale):
// Flux reverts direct spec changes on its next reconcile (~minutes), so "success" would
// be a lie — refuse up front with the real fix location. rollout_restart is exempt
// (the restartedAt annotation is not a Flux-managed field, SSA ownership keeps it).
export function assertNotGitOpsManaged(labels: Record<string, string> | undefined, target: string): void {
  const l = labels ?? {};
  const flux =
    (l["kustomize.toolkit.fluxcd.io/name"] && `Flux Kustomization "${l["kustomize.toolkit.fluxcd.io/namespace"] ?? "?"}/${l["kustomize.toolkit.fluxcd.io/name"]}"`) ||
    (l["helm.toolkit.fluxcd.io/name"] && `Flux HelmRelease "${l["helm.toolkit.fluxcd.io/namespace"] ?? "?"}/${l["helm.toolkit.fluxcd.io/name"]}"`);
  if (flux) {
    throw new ValidationError(
      `${target} is managed by ${flux} — a direct change would be reverted on the next Flux reconcile. Change it in the GitOps repository instead (rollout_restart is still allowed).`
    );
  }
  if (l["app.kubernetes.io/managed-by"] === "Helm") {
    throw new ValidationError(
      `${target} is managed by Helm — a direct change would be lost on the next helm upgrade. Change the chart values instead (rollout_restart is still allowed).`
    );
  }
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
