import { z } from "zod";
import { blankToUndefined } from "../schemas.js";
import { getApi, k8s } from "../client.js";
import { withUpstream, ValidationError } from "../../../utils/errors/index.js";
import { assertNamespaceAllowed, assertScaleAllowed, gitOpsVerdict } from "../guardrails.js";
import { provenanceOf, ageInDays, type ManagedBy } from "../provenance.js";
import config from "../../../config/index.js";

// [WRITE] handlers — typed, whitelisted actions only (never a generic patch tool: that
// would be arbitrary kubectl in disguise). Every handler: zod-validated input →
// server-side namespace guardrail → optional K8s server-side dry run (full validation,
// zero change) → compact old→new result for the approval card.

const KINDS = ["deployment", "statefulset", "daemonset"] as const;
type Kind = (typeof KINDS)[number];

const patchOpts = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.StrategicMergePatch);

function readWorkload(kind: Kind, name: string, namespace: string) {
  const api = getApi(k8s.AppsV1Api);
  if (kind === "deployment") return api.readNamespacedDeployment({ name, namespace });
  if (kind === "statefulset") return api.readNamespacedStatefulSet({ name, namespace });
  return api.readNamespacedDaemonSet({ name, namespace });
}

function patchWorkload(kind: Kind, name: string, namespace: string, body: object, dryRun?: boolean) {
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
function gitOpsPreviewOrRefuse(
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

// ---- k8s_delete_orphan ----

/**
 * The kinds a stored manifest fully restores, and nothing else.
 *
 * Secret and PersistentVolumeClaim are absent deliberately, for two different reasons:
 *
 * - A Secret's backup is its `data`, so backing one up copies credentials into the agent's
 *   Postgres and into a Slack thread — two stores not designed to hold them, one of which the
 *   dashboard reads. Redacting `data` makes the backup unrestorable, which means the delete is
 *   not reversible and the backup is theatre.
 * - A PVC's manifest is not its data. With `reclaimPolicy: Delete` the PV and everything on it
 *   goes with the claim, and re-applying the manifest returns an empty volume.
 *
 * Workloads are here only at zero replicas — see the guard below. `Service` excludes the
 * `default/kubernetes` API service, which is unreferenced by construction and would end the
 * cluster's day.
 */
const ORPHAN_KINDS = ["configmap", "service", "serviceaccount", "deployment", "statefulset"] as const;
type OrphanKind = (typeof ORPHAN_KINDS)[number];

/**
 * A `managedBy: none` object younger than this is not abandoned, it is new. Somebody is probably
 * mid-way through building the thing that will reference it, and the scan cannot see an intent.
 */
const MIN_ORPHAN_AGE_DAYS = 14;

const DeleteOrphan = z.object({
  namespace: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(ORPHAN_KINDS),
  dry_run: z.boolean().optional(),
});

function readOrphan(kind: OrphanKind, name: string, namespace: string) {
  const core = getApi(k8s.CoreV1Api);
  const apps = getApi(k8s.AppsV1Api);
  if (kind === "configmap") return core.readNamespacedConfigMap({ name, namespace });
  if (kind === "service") return core.readNamespacedService({ name, namespace });
  if (kind === "serviceaccount") return core.readNamespacedServiceAccount({ name, namespace });
  if (kind === "deployment") return apps.readNamespacedDeployment({ name, namespace });
  return apps.readNamespacedStatefulSet({ name, namespace });
}

function removeOrphan(kind: OrphanKind, name: string, namespace: string, dryRun?: boolean) {
  const core = getApi(k8s.CoreV1Api);
  const apps = getApi(k8s.AppsV1Api);
  const args = { name, namespace, ...(dryRun ? { dryRun: "All" } : {}) };
  if (kind === "configmap") return core.deleteNamespacedConfigMap(args);
  if (kind === "service") return core.deleteNamespacedService(args);
  if (kind === "serviceaccount") return core.deleteNamespacedServiceAccount(args);
  if (kind === "deployment") return apps.deleteNamespacedDeployment(args);
  return apps.deleteNamespacedStatefulSet(args);
}

const API_VERSION: Record<OrphanKind, string> = {
  configmap: "v1",
  service: "v1",
  serviceaccount: "v1",
  deployment: "apps/v1",
  statefulset: "apps/v1",
};
const KIND_NAME: Record<OrphanKind, string> = {
  configmap: "ConfigMap",
  service: "Service",
  serviceaccount: "ServiceAccount",
  deployment: "Deployment",
  statefulset: "StatefulSet",
};

/** Server-set fields that make a manifest un-appliable. `status` goes for the same reason. */
const SERVER_FIELDS = [
  "uid", "resourceVersion", "generation", "creationTimestamp", "managedFields",
  "selfLink", "ownerReferences", "finalizers",
];

/**
 * The object as `kubectl apply -f` would accept it back.
 *
 * Exported for the test, because "the backup restores the thing we deleted" is the single claim
 * that makes this tool acceptable at all, and it is the claim easiest to break by accident —
 * one leftover `resourceVersion` and every restore fails with a conflict at the worst moment.
 */
export function restorableManifest(kind: OrphanKind, obj: Record<string, unknown>): Record<string, unknown> {
  const meta = { ...((obj.metadata ?? {}) as Record<string, unknown>) };
  for (const f of SERVER_FIELDS) delete meta[f];
  const annotations = { ...((meta.annotations ?? {}) as Record<string, string>) };
  // Written by client-side apply and rejected on re-apply if stale.
  delete annotations["kubectl.kubernetes.io/last-applied-configuration"];
  if (Object.keys(annotations).length > 0) meta.annotations = annotations;
  else delete meta.annotations;

  const spec = obj.spec as Record<string, unknown> | undefined;
  const cleanSpec = spec ? { ...spec } : undefined;
  // A Service's assigned IPs belong to this cluster's allocator, not to the manifest — keeping
  // them makes the restore fail with "provided IP is already allocated" on any other cluster and
  // sometimes on this one.
  if (cleanSpec && kind === "service") {
    delete cleanSpec.clusterIP;
    delete cleanSpec.clusterIPs;
  }
  return {
    apiVersion: API_VERSION[kind],
    kind: KIND_NAME[kind],
    metadata: meta,
    ...(cleanSpec ? { spec: cleanSpec } : {}),
    ...(obj.data ? { data: obj.data } : {}),
    ...(obj.binaryData ? { binaryData: obj.binaryData } : {}),
    ...(obj.secrets ? { secrets: obj.secrets } : {}),
    ...(obj.imagePullSecrets ? { imagePullSecrets: obj.imagePullSecrets } : {}),
  };
}

/** "Certificate/api-tls" from the controlling ownerReference, if any. */
function ownerRefOf(meta: Record<string, unknown>): string | undefined {
  const refs = meta.ownerReferences as Array<{ kind?: string; name?: string }> | undefined;
  const o = refs?.[0];
  return o?.kind ? `${o.kind}/${o.name}` : undefined;
}

export interface OrphanCheck {
  managedBy: ManagedBy;
  createdAt?: string;
  owner?: string;
  replicas?: number;
  namespace: string;
  name: string;
  kind: OrphanKind;
}

/**
 * Every reason this object must not be deleted, or null. Pure, and exported, because each of
 * these is a live object someone keeps if the check is wrong.
 */
export function orphanRefusal(c: OrphanCheck, now: number = Date.now()): string | null {
  const target = `${c.kind} \`${c.namespace}/${c.name}\``;
  if (c.kind === "service" && c.namespace === "default" && c.name === "kubernetes") {
    return "The `default/kubernetes` Service is the API server's own endpoint — it is unreferenced by construction and deleting it takes the cluster with it.";
  }
  if (c.managedBy !== "none") {
    return (
      `${target} is declared by ${c.managedBy} — deleting it from the cluster is undone on the next ` +
      `reconcile, and something declaring it on purpose is evidence the "unused" finding is wrong. ` +
      `Remove it from the GitOps repo instead.`
    );
  }
  if (c.owner) {
    return `${target} is owned by ${c.owner} — its controller manages its lifecycle and Kubernetes garbage-collects it with the owner.`;
  }
  if ((c.kind === "deployment" || c.kind === "statefulset") && (c.replicas ?? 0) !== 0) {
    return `${target} still runs ${c.replicas} replica(s) — quarantine it to zero and let it sit before proposing removal.`;
  }
  const age = ageInDays(c.createdAt, now);
  if (age === null) {
    return `${target} has no creationTimestamp, so its age cannot be established — and age is the only evidence of abandonment available here.`;
  }
  if (age < MIN_ORPHAN_AGE_DAYS) {
    return `${target} is ${age} day(s) old. Under ${MIN_ORPHAN_AGE_DAYS} days that is not abandoned, it is new — somebody is probably still building what will reference it.`;
  }
  return null;
}

export const deleteOrphan = (input: unknown) => {
  const { namespace, name, kind, dry_run } = DeleteOrphan.parse(input);
  assertNamespaceAllowed(namespace, config.writeTools.allowedNamespaces);

  return withUpstream("kubernetes", `Failed to delete ${kind} \`${namespace}/${name}\``, async () => {
    const current = (await readOrphan(kind, name, namespace)) as unknown as Record<string, unknown>;
    const meta = (current.metadata ?? {}) as Record<string, unknown>;
    const { managedBy, createdAt } = provenanceOf(meta as never);

    const refusal = orphanRefusal({
      kind, namespace, name, managedBy, createdAt,
      owner: ownerRefOf(meta),
      replicas: (current.spec as { replicas?: number } | undefined)?.replicas,
    });
    if (refusal) throw new ValidationError(refusal);

    // Captured HERE, immediately before the delete — not at proposal time. The object can change
    // between a card being posted and someone clicking Approve, and what has to be stored is what
    // was actually removed.
    const manifest = restorableManifest(kind, current);
    await removeOrphan(kind, name, namespace, dry_run);

    return {
      action: "delete_orphan",
      target: `${kind}/${namespace}/${name}`,
      managedBy,
      createdAt,
      ageDays: ageInDays(createdAt),
      dryRun: !!dry_run,
      // The caller stores this and posts it to the thread. It is the entire undo.
      backupManifest: manifest,
      restoreWith: `kubectl apply -f - <<'EOF'\n<the manifest above, as YAML>\nEOF`,
      result: dry_run
        ? "validated (nothing was deleted) — the manifest above is what would be removed"
        : `deleted; restore by re-applying backupManifest`,
    };
  });
};
