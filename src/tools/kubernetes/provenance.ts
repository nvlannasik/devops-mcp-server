/**
 * Who put an object in the cluster, as the object itself records it.
 *
 * Shared by the unused scan (which reports it) and `k8s_delete_orphan` (which refuses without
 * it), for the same reason `podspec.ts` is shared: two copies of this rule drift, and the
 * direction they drift in is "the reporting side says nothing declares this, the deleting side
 * agrees, and Flux had a label neither of them read".
 *
 * The distinction decides everything about removal, and it inverts the obvious intuition:
 *
 * - `flux` / `helm` — something DECLARES this object. Deleting it through the API is a no-op the
 *   next reconcile undoes, so the durable removal is a PR. It is also evidence the "unused"
 *   finding is wrong, because a human declared that object on purpose.
 * - `none` — the object exists ONLY in etcd. Nothing anywhere holds a copy, so this is the case
 *   where a wrong delete is unrecoverable. Not the safe case: the dangerous one.
 *
 * And `none` does NOT mean "nothing uses it". It means nothing declares it. An app that reads
 * its own ConfigMap through the API leaves no trace in any pod spec, carries no Flux label and
 * no ownerReference — it is `none`, and it is load-bearing. Kubernetes records no reads, so that
 * gap cannot be closed from the API at all. It is why deletion is backed up before it runs.
 */
export type ManagedBy = "flux" | "helm" | "none";

/** Set by the Kustomization controller on everything it applies. */
const FLUX_LABEL = "kustomize.toolkit.fluxcd.io/name";
/** Helm writes this on every object in a release. */
const HELM_ANNOTATION = "meta.helm.sh/release-name";

export interface ProvenanceMeta {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: Date | string;
}

export interface Provenance {
  managedBy: ManagedBy;
  /** RFC-3339. An orphan's age turns "unused" into "unused since". */
  createdAt?: string;
}

export const provenanceOf = (m?: ProvenanceMeta): Provenance => ({
  // Flux first: a Flux-managed HelmRelease produces objects carrying BOTH markers, and the
  // actionable answer there is the Kustomization's repo path, not the Helm release.
  managedBy: m?.labels?.[FLUX_LABEL] ? "flux" : m?.annotations?.[HELM_ANNOTATION] ? "helm" : "none",
  // Normalised here rather than at each reader: the client hands back a Date for some kinds and
  // the raw string for others, and `${date}` is a local-time sentence, not a timestamp.
  createdAt: m?.creationTimestamp ? new Date(m.creationTimestamp).toISOString() : undefined,
});

/** Whole days since creation, or null when the object carries no timestamp to measure from. */
export function ageInDays(createdAt: string | undefined, now: number = Date.now()): number | null {
  if (!createdAt) return null;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}
