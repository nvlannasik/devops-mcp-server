import { z } from "zod";
import { getApi, k8s } from "../../client.js";
import { withUpstream, ValidationError, conciseCause } from "../../../../utils/errors/index.js";
import { assertNamespaceAllowed } from "../../guardrails.js";
import { diffPodTemplates, type PodTemplate } from "../changes.js";
import config from "../../../../config/index.js";
import { gitOpsPreviewOrRefuse } from "./shared.js";

// ---- k8s_rollout_undo ----
//
// Undo the change that broke a Deployment: put its pod template back to an older ReplicaSet's,
// which is what `kubectl rollout undo --to-revision` does. Not `k8s_set_image`: every image here
// is `:latest`, so a bad rollout is a template change (env, args, resources, probes), not a tag.
// The agent's rollback gate decides WHICH revision — the one before the change its timeline
// names; this handler only refuses what cannot be done.

type RsLike = {
  metadata?: { annotations?: Record<string, string>; ownerReferences?: Array<{ controller?: boolean; kind?: string; uid?: string }> };
  spec?: { template?: PodTemplate & { metadata?: { labels?: Record<string, string> } } };
};

// exported for unit tests — the ReplicaSet this Deployment owns at `revision`, or null
export function pickRevision<T extends RsLike>(items: T[], deploymentUid: string | undefined, revision: number): T | null {
  return (
    items.find(
      (r) =>
        r.metadata?.ownerReferences?.some((o) => o.controller && o.kind === "Deployment" && o.uid === deploymentUid) &&
        r.metadata?.annotations?.["deployment.kubernetes.io/revision"] === String(revision)
    ) ?? null
  );
}

// exported for unit tests — the ReplicaSet's template minus the label its controller added
export function templateForUndo<T extends { metadata?: { labels?: Record<string, string> } }>(t: T): T {
  const copy = structuredClone(t);
  if (copy.metadata?.labels) delete copy.metadata.labels["pod-template-hash"];
  return copy;
}

const RolloutUndo = z.object({
  namespace: z.string().min(1),
  name: z.string().min(1),
  kind: z.literal("deployment").optional().default("deployment"),
  to_revision: z.number().int().min(1),
  // the live revision the approval card was proposed against — the patch then tests it first,
  // so an approve after the Deployment moved fails at the API server instead of undoing a
  // revision nobody saw
  from_revision: z.number().int().min(1).optional(),
  dry_run: z.boolean().optional(),
});

const REVISION_PATH = "/metadata/annotations/deployment.kubernetes.io~1revision";

// exported for unit tests — the JSON patch; the `test` op makes the API server reject it
// atomically when the live revision is no longer `fromRevision`
export function undoPatchBody(template: object, fromRevision?: number): object[] {
  const replace = { op: "replace", path: "/spec/template", value: template };
  return fromRevision === undefined ? [replace] : [{ op: "test", path: REVISION_PATH, value: String(fromRevision) }, replace];
}

const jsonPatchOpts = k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.JsonPatch);

// the API server answers a failed JSON-patch `test` op with 422 (409 on a write conflict);
// conciseCause reads the Status message out of the ApiException body
const isFailedRevisionTest = (err: unknown): boolean => {
  const code = (err as { code?: unknown })?.code;
  return (code === 422 || code === 409) && /\btest\b/i.test(conciseCause(err));
};

export const rolloutUndo = (input: unknown) => {
  const { namespace, name, to_revision, from_revision, dry_run } = RolloutUndo.parse(input);
  assertNamespaceAllowed(namespace, config.writeTools.allowedNamespaces);
  const label = `deployment \`${namespace}/${name}\``;

  return withUpstream("kubernetes", `Failed to roll back ${label}`, async () => {
    const api = getApi(k8s.AppsV1Api);
    const current = await api.readNamespacedDeployment({ name, namespace });
    const fromRevision = Number(current.metadata?.annotations?.["deployment.kubernetes.io/revision"]);
    if (!Number.isFinite(fromRevision)) {
      throw new ValidationError(`\`${namespace}/${name}\` has no revision annotation yet — the deployment controller has not observed it; retry shortly`);
    }
    // Flux first: a revert PR needs neither a retained ReplicaSet nor a cluster that differs —
    // the agent's stale check reads `fromRevision` from this preview too
    const preview = gitOpsPreviewOrRefuse(current.metadata?.labels, label, !!dry_run, {
      workload: `deployment/${namespace}/${name}`,
      action: "rollback",
      changes: [],
    });
    if (preview) return { ...preview, toRevision: to_revision, fromRevision };
    if (fromRevision === to_revision) throw new ValidationError(`${label} is already running revision ${to_revision} — nothing to roll back to`);
    const items = (await api.listNamespacedReplicaSet({ namespace })).items as RsLike[];
    const target = pickRevision(items, current.metadata?.uid, to_revision);
    if (!target?.spec?.template) {
      const kept = items
        .filter((r) => r.metadata?.ownerReferences?.some((o) => o.controller && o.uid === current.metadata?.uid))
        .map((r) => r.metadata?.annotations?.["deployment.kubernetes.io/revision"]);
      throw new ValidationError(`${label} has no ReplicaSet at revision ${to_revision} (kept: ${kept.join(", ") || "none"}) — it may have been removed by revisionHistoryLimit`);
    }
    const template = templateForUndo(target.spec.template);
    const diff = diffPodTemplates((current.spec?.template ?? {}) as PodTemplate, template);
    try {
      await api.patchNamespacedDeployment(
        { name, namespace, body: undoPatchBody(template, from_revision), ...(dry_run ? { dryRun: "All" } : {}) },
        jsonPatchOpts
      );
    } catch (err) {
      if (from_revision !== undefined && isFailedRevisionTest(err)) {
        throw new ValidationError(`\`${namespace}/${name}\` moved from revision ${from_revision} since the card was proposed — re-investigate`);
      }
      throw err;
    }
    return {
      action: "rollout_undo",
      workload: `deployment/${namespace}/${name}`,
      fromRevision,
      toRevision: to_revision,
      diff,
      dryRun: !!dry_run,
      result: dry_run ? "validated — the rollback patch is accepted (nothing was changed)" : `rolled back to revision ${to_revision} — rolling update in progress`,
    };
  });
};
