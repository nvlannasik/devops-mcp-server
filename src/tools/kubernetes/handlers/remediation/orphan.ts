import { z } from "zod";
import { getApi, k8s } from "../../client.js";
import { withUpstream, ValidationError } from "../../../../utils/errors/index.js";
import { assertNamespaceAllowed } from "../../guardrails.js";
import { provenanceOf, ageInDays, type ManagedBy } from "../../provenance.js";
import config from "../../../../config/index.js";

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
 *
 * Read from config (`MIN_ORPHAN_AGE_DAYS`, default 14) rather than fixed, so the benchmark can
 * exercise the delete path at all — Kubernetes owns `creationTimestamp`, so a case cannot age its
 * own fixture. Read at CALL time, not once at module load, so a test that changes it does not
 * depend on import order.
 */
const minOrphanAgeDays = (): number => config.writeTools.minOrphanAgeDays;

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
  if (age < minOrphanAgeDays()) {
    return `${target} is ${age} day(s) old. Under ${minOrphanAgeDays()} days that is not abandoned, it is new — somebody is probably still building what will reference it.`;
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
