import { z } from "zod";
import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { assertNamespaceAllowed, assertScaleAllowed, assertNotGitOpsManaged } from "../guardrails.js";
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
  container: z.string().min(1).optional(), // omitted = auto-resolve for single-container workloads
  image: z.string().min(1),
  dry_run: z.boolean().optional(),
});

export const setImage = (input: unknown) => {
  const { namespace, name, kind, container, image, dry_run } = SetImage.parse(input);
  assertNamespaceAllowed(namespace, config.writeTools.allowedNamespaces);

  return withUpstream("kubernetes", `Failed to set image on ${kind} \`${namespace}/${name}\``, async () => {
    const current = await readWorkload(kind, name, namespace);
    assertNotGitOpsManaged(current.metadata?.labels, `${kind} \`${namespace}/${name}\``);
    const target = findContainer(current, container, `${kind} \`${namespace}/${name}\``);
    const containerName = target.name ?? container ?? "";
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
  dry_run: z.boolean().optional(),
});

export const scale = (input: unknown) => {
  const { namespace, name, kind, replicas, dry_run } = Scale.parse(input);
  assertNamespaceAllowed(namespace, config.writeTools.allowedNamespaces);

  return withUpstream("kubernetes", `Failed to scale ${kind} \`${namespace}/${name}\``, async () => {
    const current = await readWorkload(kind, name, namespace);
    assertNotGitOpsManaged(current.metadata?.labels, `${kind} \`${namespace}/${name}\``);
    const currentReplicas = (current.spec as { replicas?: number }).replicas ?? 0;
    assertScaleAllowed(currentReplicas, replicas, config.writeTools.maxScaleDelta); // delta bound + no scale-to-zero

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
    container: z.string().min(1).optional(), // omitted = auto-resolve for single-container workloads
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
    assertNotGitOpsManaged(current.metadata?.labels, `${kind} \`${namespace}/${name}\``);
    const target = findContainer(current, container, `${kind} \`${namespace}/${name}\``);
    const containerName = target.name ?? container ?? "";
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
