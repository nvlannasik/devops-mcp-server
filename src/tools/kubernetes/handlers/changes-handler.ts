import { z } from "zod";
import { getApi, k8s } from "../client.js";
import { NS } from "../schemas.js";
import {
  configChanges, helmChanges, referencedConfigMaps, rolloutChanges,
  type Change, type ConfigMapMeta, type HelmHistoryEntry, type PodTemplate, type Revision,
} from "./changes.js";

// k8s_change_timeline — the reads behind the pure diffing in changes.ts. Each source is read
// independently and a failing one is NAMED in `unread`: the agent must never read "helm: 403"
// as "no Helm upgrade happened" (same rule as AlertState unknown ≠ none in the agent).

export interface TimelineSources {
  rollouts(namespace: string): Promise<Array<{ workload: string; revisions: Revision[] }>>;
  helmReleases(namespace: string): Promise<Array<{ name: string; namespace: string; history: HelmHistoryEntry[] }>>;
  configMaps(namespace: string): Promise<ConfigMapMeta[]>;
}
export interface TimelineResult {
  namespace: string;
  window: { from: string; to: string };
  changes: Change[];
  helmReleases: Array<{ name: string; namespace: string }>;
  unread: string[];
}

const MAX_CHANGES = 50;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export async function buildTimeline(src: TimelineSources, namespace: string, sinceHours: number, now = new Date()): Promise<TimelineResult> {
  const w = { from: new Date(now.getTime() - sinceHours * 3_600_000), to: now };
  const [ro, hr, cm] = await Promise.allSettled([src.rollouts(namespace), src.helmReleases(namespace), src.configMaps(namespace)]);
  const unread: string[] = [];
  const changes: Change[] = [];
  let referenced: Set<string> | null = null;
  if (ro.status === "fulfilled") {
    for (const r of ro.value) changes.push(...rolloutChanges(r.workload, r.revisions, w));
    // the templates in use now are each workload's newest revision
    referenced = referencedConfigMaps(
      ro.value.map((r) => [...r.revisions].sort((a, b) => b.revision - a.revision)[0]?.template).filter((t): t is PodTemplate => !!t)
    );
  } else unread.push(`rollout: ${msg(ro.reason)}`);
  const helmReleases: TimelineResult["helmReleases"] = [];
  if (hr.status === "fulfilled") {
    for (const h of hr.value) {
      helmReleases.push({ name: h.name, namespace: h.namespace });
      changes.push(...helmChanges(h.name, h.history, w));
    }
  } else unread.push(`helm: ${msg(hr.reason)}`);
  if (cm.status === "fulfilled") changes.push(...configChanges(cm.value, referenced, w));
  else unread.push(`config: ${msg(cm.reason)}`);
  changes.sort((a, b) => b.at.localeCompare(a.at));
  return { namespace, window: { from: w.from.toISOString(), to: w.to.toISOString() }, changes: changes.slice(0, MAX_CHANGES), helmReleases, unread };
}

const ts = (d: Date | string | undefined): string => (d instanceof Date ? d.toISOString() : d ?? "");
const controller = (refs: k8s.V1OwnerReference[] | undefined) => refs?.find((o) => o.controller);

export const k8sSources: TimelineSources = {
  async rollouts(namespace) {
    const apps = getApi(k8s.AppsV1Api);
    const [rs, cr] = await Promise.all([
      apps.listNamespacedReplicaSet({ namespace }),
      apps.listNamespacedControllerRevision({ namespace }),
    ]);
    const groups = new Map<string, Revision[]>();
    const push = (workload: string, r: Revision) => groups.set(workload, [...(groups.get(workload) ?? []), r]);
    for (const r of rs.items) {
      const owner = controller(r.metadata?.ownerReferences);
      const rev = Number(r.metadata?.annotations?.["deployment.kubernetes.io/revision"]);
      if (owner?.kind !== "Deployment" || !Number.isFinite(rev)) continue;
      push(`Deployment/${owner.name}`, { revision: rev, at: ts(r.metadata?.creationTimestamp), template: (r.spec?.template ?? {}) as PodTemplate });
    }
    for (const c of cr.items) {
      const owner = controller(c.metadata?.ownerReferences);
      if (owner?.kind !== "StatefulSet" && owner?.kind !== "DaemonSet") continue;
      const template = ((c.data as { spec?: { template?: PodTemplate } } | undefined)?.spec?.template ?? {}) as PodTemplate;
      push(`${owner.kind}/${owner.name}`, { revision: c.revision, at: ts(c.metadata?.creationTimestamp), template });
    }
    return [...groups].map(([workload, revisions]) => ({ workload, revisions }));
  },
  async helmReleases(namespace) {
    const res = (await getApi(k8s.CustomObjectsApi).listClusterCustomObject({ group: "helm.toolkit.fluxcd.io", version: "v2", plural: "helmreleases" })) as {
      items?: Array<{ metadata?: { name?: string; namespace?: string }; spec?: { targetNamespace?: string }; status?: { history?: HelmHistoryEntry[] } }>;
    };
    return (res.items ?? [])
      .filter((h) => (h.spec?.targetNamespace ?? h.metadata?.namespace) === namespace)
      .map((h) => ({ name: h.metadata?.name ?? "", namespace: h.metadata?.namespace ?? "", history: h.status?.history ?? [] }));
  },
  async configMaps(namespace) {
    // ponytail: lists full ConfigMaps for their managedFields; switch to a metadata-only list if a namespace's ConfigMaps get large
    const res = await getApi(k8s.CoreV1Api).listNamespacedConfigMap({ namespace });
    return res.items.map((c) => ({ name: c.metadata?.name ?? "", managedFields: (c.metadata?.managedFields ?? []).map((f) => ({ time: ts(f.time) })) }));
  },
};

export const getChangeTimeline = (input: unknown) => {
  const { namespace, sinceHours } = NS.extend({ sinceHours: z.number().int().min(1).max(168).default(24) }).parse(input);
  return buildTimeline(k8sSources, namespace, sinceHours);
};
