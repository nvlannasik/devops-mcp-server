import { getApi, k8s } from "../../client.js";
import { ValidationError } from "../../../../utils/errors/index.js";
import { gitOpsVerdict } from "../../guardrails.js";

export const KINDS = ["deployment", "statefulset", "daemonset"] as const;
type Kind = (typeof KINDS)[number];

const patchOpts = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.StrategicMergePatch);

export function readWorkload(kind: Kind, name: string, namespace: string) {
  const api = getApi(k8s.AppsV1Api);
  if (kind === "deployment") return api.readNamespacedDeployment({ name, namespace });
  if (kind === "statefulset") return api.readNamespacedStatefulSet({ name, namespace });
  return api.readNamespacedDaemonSet({ name, namespace });
}

export function patchWorkload(kind: Kind, name: string, namespace: string, body: object, dryRun?: boolean) {
  const api = getApi(k8s.AppsV1Api);
  const args = { name, namespace, body, ...(dryRun ? { dryRun: "All" } : {}) };
  if (kind === "deployment") return api.patchNamespacedDeployment(args, patchOpts);
  if (kind === "statefulset") return api.patchNamespacedStatefulSet(args, patchOpts);
  return api.patchNamespacedDaemonSet(args, patchOpts);
}

type WorkloadLike = { spec?: { template?: { spec?: { containers?: Array<{ name?: string; image?: string; resources?: unknown }> } } } };

// exported for unit tests — `container` omitted resolves only when unambiguous (single container)
export function findContainer(workload: WorkloadLike, container: string | undefined, label: string) {
  const containers = workload.spec?.template?.spec?.containers ?? [];
  const names = containers.map((c) => c.name).join(", ");
  if (!container) {
    if (containers.length === 1) return containers[0];
    throw new Error(`${label} has ${containers.length} containers (${names}) — specify "container"`);
  }
  const found = containers.find((c) => c.name === container);
  if (!found) {
    throw new Error(`container "${container}" not found in ${label} (has: ${names})`);
  }
  return found;
}

// ---- GitOps PR-flow preview (DESIGN_gitops_pr_remediation.md §4.1) ----

export interface GitOpsChange {
  field: string;
  from: string | number;
  to: string | number;
}

// When the workload is a Flux HelmRelease AND this is a dry run, return a structured
// PR-preview result — Step 4's agent routes it over SQS to the private-network GitOps
// handler instead of patching directly. Otherwise refuse (throw): the execute path can
// never patch a GitOps-managed workload directly, and Kustomize / plain-Helm sources are
// not PR-eligible in v2. Returns null when the workload is NOT GitOps-managed (proceed).
export function gitOpsPreviewOrRefuse(
  labels: Record<string, string> | undefined,
  target: string,
  dryRun: boolean,
  ctx: { workload: string; action: string; container?: string; changes: GitOpsChange[] }
) {
  const v = gitOpsVerdict(labels, target);
  if (!v.managed) return null;
  if (v.prEligible && dryRun) {
    // the chart component (if the workload carries the label) disambiguates the values
    // sub-tree for multi-component charts
    const component = labels?.["app.kubernetes.io/component"];
    return {
      gitOpsPrEligible: true as const,
      source: v.source,
      helmRelease: v.helmRelease!,
      workload: ctx.workload,
      action: ctx.action,
      ...(ctx.container ? { container: ctx.container } : {}),
      ...(component ? { component } : {}),
      changes: ctx.changes,
      message: v.refuseMessage,
    };
  }
  throw new ValidationError(v.refuseMessage);
}
