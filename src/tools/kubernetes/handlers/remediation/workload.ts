import { z } from "zod";
import { blankToUndefined } from "../../schemas.js";
import { getApi, k8s } from "../../client.js";
import { withUpstream, ValidationError } from "../../../../utils/errors/index.js";
import { assertNamespaceAllowed, assertScaleAllowed } from "../../guardrails.js";
import config from "../../../../config/index.js";
import { GitOpsChange, KINDS, findContainer, gitOpsPreviewOrRefuse, patchWorkload, readWorkload } from "./shared.js";

// ---- k8s_rollout_restart ----

const RolloutRestart = z.object({
  namespace: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(KINDS).optional().default("deployment"),
  dry_run: z.boolean().optional(),
});

// kubectl rollout restart equivalent: patch the pod template's restartedAt annotation —
// the workload controller then performs its normal rolling update.
export const rolloutRestart = (input: unknown) => {
  const { namespace, name, kind, dry_run } = RolloutRestart.parse(input);
  assertNamespaceAllowed(namespace, config.writeTools.allowedNamespaces);

  return withUpstream("kubernetes", `Failed to rollout-restart ${kind} \`${namespace}/${name}\``, async () => {
    const restartedAt = new Date().toISOString();
    const patch = {
      spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": restartedAt } } } },
    };
    const res = await patchWorkload(kind, name, namespace, patch, dry_run);
    return {
      action: "rollout_restart",
      workload: `${kind}/${namespace}/${name}`,
      dryRun: !!dry_run,
      result: dry_run
        ? "validated — workload exists and the restart patch is accepted (nothing was changed)"
        : "rolling restart triggered",
      restartedAt,
      // DaemonSets have no replicas field — report when present
      replicas: "replicas" in (res.spec ?? {}) ? (res.spec as { replicas?: number }).replicas : undefined,
    };
  });
};

// ---- k8s_set_image ----

const SetImage = z.object({
  namespace: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(KINDS),
  container: blankToUndefined(z.string().min(1).optional()), // omitted (or "") = auto-resolve for single-container workloads
  image: z.string().min(1),
  dry_run: z.boolean().optional(),
});

export const setImage = (input: unknown) => {
  const { namespace, name, kind, container, image, dry_run } = SetImage.parse(input);
  assertNamespaceAllowed(namespace, config.writeTools.allowedNamespaces);

  return withUpstream("kubernetes", `Failed to set image on ${kind} \`${namespace}/${name}\``, async () => {
    const current = await readWorkload(kind, name, namespace);
    const target = findContainer(current, container, `${kind} \`${namespace}/${name}\``);
    const containerName = target.name ?? container ?? "";
    const preview = gitOpsPreviewOrRefuse(current.metadata?.labels, `${kind} \`${namespace}/${name}\``, !!dry_run, {
      workload: `${kind}/${namespace}/${name}`,
      action: "set_image",
      container: containerName,
      changes: [{ field: "image", from: target.image ?? "(unset)", to: image }],
    });
    if (preview) return preview;
    // strategic merge patch merges the containers array by name — only this container changes
    const patch = { spec: { template: { spec: { containers: [{ name: containerName, image }] } } } };
    await patchWorkload(kind, name, namespace, patch, dry_run);
    return {
      action: "set_image",
      workload: `${kind}/${namespace}/${name}`,
      container: containerName,
      previousImage: target.image,
      newImage: image,
      dryRun: !!dry_run,
      result: dry_run ? "validated (nothing was changed)" : "image updated — rolling update in progress",
    };
  });
};

// ---- k8s_scale ----

// DaemonSets are excluded on purpose — they have no replicas (one pod per node).
const SCALABLE_KINDS = ["deployment", "statefulset"] as const;

const Scale = z.object({
  namespace: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(SCALABLE_KINDS),
  replicas: z.number().int().min(0), // 0 passes zod so the guardrail can give the real message
  // Opt-in, never inferred from replicas===0 — see assertScaleAllowed.
  quarantine: z.boolean().default(false),
  dry_run: z.boolean().optional(),
});

export const scale = (input: unknown) => {
  const { namespace, name, kind, replicas, quarantine, dry_run } = Scale.parse(input);
  assertNamespaceAllowed(namespace, config.writeTools.allowedNamespaces);

  return withUpstream("kubernetes", `Failed to scale ${kind} \`${namespace}/${name}\``, async () => {
    const current = await readWorkload(kind, name, namespace);
    const currentReplicas = (current.spec as { replicas?: number }).replicas ?? 0;
    assertScaleAllowed(currentReplicas, replicas, config.writeTools.maxScaleDelta, { quarantine }); // delta bound + scale-to-zero rule (applies to the PR path too)
    const preview = gitOpsPreviewOrRefuse(current.metadata?.labels, `${kind} \`${namespace}/${name}\``, !!dry_run, {
      workload: `${kind}/${namespace}/${name}`,
      action: "scale",
      changes: [{ field: "replicas", from: currentReplicas, to: replicas }],
    });
    if (preview) return preview;

    await patchWorkload(kind, name, namespace, { spec: { replicas } }, dry_run);
    return {
      action: "scale",
      workload: `${kind}/${namespace}/${name}`,
      previousReplicas: currentReplicas,
      newReplicas: replicas,
      dryRun: !!dry_run,
      result: dry_run ? "validated (nothing was changed)" : `scaled ${currentReplicas} → ${replicas}`,
    };
  });
};

// ---- k8s_set_resources ----

const SetResources = z
  .object({
    namespace: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(KINDS),
    container: blankToUndefined(z.string().min(1).optional()), // omitted (or "") = auto-resolve for single-container workloads
    // K8s quantity strings ("250m", "512Mi") — the server-side dry run validates the format
    cpu_request: z.string().optional(),
    memory_request: z.string().optional(),
    cpu_limit: z.string().optional(),
    memory_limit: z.string().optional(),
    dry_run: z.boolean().optional(),
  })
  .refine((o) => o.cpu_request || o.memory_request || o.cpu_limit || o.memory_limit, {
    message: "at least one of cpu_request/memory_request/cpu_limit/memory_limit is required",
  });

type ResourceFields = { cpu_request?: string; memory_request?: string; cpu_limit?: string; memory_limit?: string };

// exported for unit tests — maps the provided resource fields to {field, from, to} changes
// for the GitOps PR preview, pulling `from` from the container's current resources
export function resourceChanges(
  currentResources: { requests?: Record<string, string>; limits?: Record<string, string> } | undefined,
  f: ResourceFields
): GitOpsChange[] {
  const cur = currentResources ?? {};
  const out: GitOpsChange[] = [];
  if (f.cpu_request) out.push({ field: "requests.cpu", from: cur.requests?.cpu ?? "(unset)", to: f.cpu_request });
  if (f.memory_request) out.push({ field: "requests.memory", from: cur.requests?.memory ?? "(unset)", to: f.memory_request });
  if (f.cpu_limit) out.push({ field: "limits.cpu", from: cur.limits?.cpu ?? "(unset)", to: f.cpu_limit });
  if (f.memory_limit) out.push({ field: "limits.memory", from: cur.limits?.memory ?? "(unset)", to: f.memory_limit });
  return out;
}

// exported for unit tests — builds a patch containing ONLY the provided values
export function buildResourcesPatch(container: string, f: ResourceFields) {
  const requests: Record<string, string> = {};
  const limits: Record<string, string> = {};
  if (f.cpu_request) requests.cpu = f.cpu_request;
  if (f.memory_request) requests.memory = f.memory_request;
  if (f.cpu_limit) limits.cpu = f.cpu_limit;
  if (f.memory_limit) limits.memory = f.memory_limit;
  const resources: Record<string, Record<string, string>> = {};
  if (Object.keys(requests).length > 0) resources.requests = requests;
  if (Object.keys(limits).length > 0) resources.limits = limits;
  return { spec: { template: { spec: { containers: [{ name: container, resources }] } } } };
}

export const setResources = (input: unknown) => {
  const { namespace, name, kind, container, dry_run, ...fields } = SetResources.parse(input);
  assertNamespaceAllowed(namespace, config.writeTools.allowedNamespaces);

  return withUpstream("kubernetes", `Failed to set resources on ${kind} \`${namespace}/${name}\``, async () => {
    const current = await readWorkload(kind, name, namespace);
    const target = findContainer(current, container, `${kind} \`${namespace}/${name}\``);
    const containerName = target.name ?? container ?? "";
    const preview = gitOpsPreviewOrRefuse(current.metadata?.labels, `${kind} \`${namespace}/${name}\``, !!dry_run, {
      workload: `${kind}/${namespace}/${name}`,
      action: "set_resources",
      container: containerName,
      changes: resourceChanges(target.resources as { requests?: Record<string, string>; limits?: Record<string, string> } | undefined, fields),
    });
    if (preview) return preview;
    await patchWorkload(kind, name, namespace, buildResourcesPatch(containerName, fields), dry_run);
    return {
      action: "set_resources",
      workload: `${kind}/${namespace}/${name}`,
      container: containerName,
      previousResources: target.resources ?? {},
      newValues: fields,
      dryRun: !!dry_run,
      result: dry_run ? "validated (nothing was changed)" : "resources updated — rolling update in progress",
    };
  });
};

// ---- k8s_delete_pod ----

// Deleting a pod is only a remediation when a controller brings a replacement.
// Job pods are excluded on purpose (a completed/failed Job won't recreate).
const RECREATING_OWNERS = new Set(["ReplicaSet", "StatefulSet", "DaemonSet"]);

// exported for unit tests
export function findRecreatingOwner(meta?: { ownerReferences?: Array<{ kind?: string; name?: string; controller?: boolean }> }) {
  return (meta?.ownerReferences ?? []).find((o) => o.controller && RECREATING_OWNERS.has(o.kind ?? "")) ?? null;
}

const DeletePod = z.object({
  namespace: z.string().min(1),
  pod: z.string().min(1),
  dry_run: z.boolean().optional(),
});

export const deletePod = (input: unknown) => {
  const { namespace, pod, dry_run } = DeletePod.parse(input);
  assertNamespaceAllowed(namespace, config.writeTools.allowedNamespaces);

  return withUpstream("kubernetes", `Failed to delete pod \`${namespace}/${pod}\``, async () => {
    const api = getApi(k8s.CoreV1Api);
    const current = await api.readNamespacedPod({ name: pod, namespace });
    const owner = findRecreatingOwner(current.metadata);
    if (!owner) {
      throw new ValidationError(
        `pod \`${namespace}/${pod}\` has no recreating controller (ReplicaSet/StatefulSet/DaemonSet) — deleting it would not bring a replacement; that is an outage, not a remediation`
      );
    }
    // no GitOps guard on purpose: like rollout_restart, a recreated pod is reconcile-safe
    await api.deleteNamespacedPod({ name: pod, namespace, ...(dry_run ? { dryRun: "All" } : {}) });
    return {
      action: "delete_pod",
      pod: `${namespace}/${pod}`,
      owner: `${owner.kind}/${owner.name}`,
      dryRun: !!dry_run,
      result: dry_run
        ? `validated — pod exists and ${owner.kind}/${owner.name} will recreate it (nothing was changed)`
        : `pod deleted — ${owner.kind}/${owner.name} is recreating it`,
    };
  });
};
