import { z } from "zod";
import { getApi, k8s, listAll } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { blankToUndefined } from "../schemas.js";
import { gitOpsVerdict } from "../guardrails.js";

// The whole cluster's workloads, their owners and what they expose, in ONE call — the onboarding
// counterpart of k8s_cluster_health. Every other list tool is per-namespace, so "what runs here"
// cost one call per namespace per kind. Names, counts, images, ports and hosts only: no env, no
// ConfigMap/Secret content, no annotation text — small, and nothing in it is free text to inject.

const SYSTEM = new Set(["kube-system", "kube-public", "kube-node-lease", "flux-system"]);

type Labels = Record<string, string> | undefined;
interface Obj { metadata?: { name?: string; namespace?: string; labels?: Labels } }
interface PodSpecHolder { spec?: { containers?: Array<{ image?: string }> } }
interface WorkloadObj extends Obj { spec?: { replicas?: number; template?: PodSpecHolder }; status?: { readyReplicas?: number; numberReady?: number; desiredNumberScheduled?: number } }
interface CronObj extends Obj { spec?: { schedule?: string; jobTemplate?: { spec?: { template?: PodSpecHolder } } } }
interface ServiceObj extends Obj { spec?: { type?: string; ports?: Array<{ port?: number; protocol?: string; targetPort?: number | string }> } }
interface IngressObj extends Obj { spec?: { rules?: Array<{ host?: string }> } }
interface KustomizationObj { metadata: { name: string; namespace: string }; spec?: { path?: string } }

export type ManagedBy =
  | { type: "helmrelease"; name: string; namespace: string; chart?: string }
  | { type: "kustomization"; name: string; namespace: string; path?: string }
  | { type: "helm"; chart?: string }
  | { type: "unmanaged" };

export interface InventoryWorkload {
  kind: "Deployment" | "StatefulSet" | "DaemonSet" | "CronJob";
  name: string; ready: number | null; desired: number | null; images: string[]; managedBy: ManagedBy; schedule?: string;
}

export interface InventoryInput {
  namespaces: string[];
  deployments: WorkloadObj[];
  statefulsets: WorkloadObj[];
  daemonsets: WorkloadObj[];
  cronjobs: CronObj[];
  services: ServiceObj[];
  ingresses: IngressObj[];
  /** null = the CR list was refused (RBAC) — paths are then absent, not guessed. */
  kustomizations: KustomizationObj[] | null;
  complete: boolean;
}

function managedBy(labels: Labels, paths: Map<string, string>): ManagedBy {
  const v = gitOpsVerdict(labels, "");
  const chart = labels?.["helm.sh/chart"];
  if (!v.managed) return { type: "unmanaged" };
  if (v.source === "flux-helmrelease" && v.helmRelease) return { type: "helmrelease", ...v.helmRelease, ...(chart ? { chart } : {}) };
  if (v.source === "flux-kustomization" && v.kustomization) {
    const path = paths.get(`${v.kustomization.namespace}/${v.kustomization.name}`);
    return { type: "kustomization", ...v.kustomization, ...(path ? { path } : {}) };
  }
  return { type: "helm", ...(chart ? { chart } : {}) };
}

const images = (t: PodSpecHolder | undefined): string[] =>
  [...new Set((t?.spec?.containers ?? []).map((c) => c.image).filter((i): i is string => !!i))];

export function shapeInventory(input: InventoryInput) {
  const paths = new Map(
    (input.kustomizations ?? []).filter((k) => k.spec?.path).map((k) => [`${k.metadata.namespace}/${k.metadata.name}`, k.spec!.path!] as const)
  );
  const byNs = new Map(
    input.namespaces.map((name) => [name, {
      name, system: SYSTEM.has(name),
      workloads: [] as InventoryWorkload[],
      services: [] as Array<{ name: string; type: string; ports: string[] }>,
      ingresses: [] as Array<{ name: string; hosts: string[] }>,
    }])
  );
  const at = (o: Obj) => byNs.get(o.metadata?.namespace ?? "");
  const owner = (o: Obj) => managedBy(o.metadata?.labels, paths);
  const workload = (kind: InventoryWorkload["kind"], o: WorkloadObj, ready: number, desired: number | null) =>
    at(o)?.workloads.push({ kind, name: o.metadata?.name ?? "", ready, desired, images: images(o.spec?.template), managedBy: owner(o) });
  for (const d of input.deployments) workload("Deployment", d, d.status?.readyReplicas ?? 0, d.spec?.replicas ?? null);
  for (const s of input.statefulsets) workload("StatefulSet", s, s.status?.readyReplicas ?? 0, s.spec?.replicas ?? null);
  for (const d of input.daemonsets) workload("DaemonSet", d, d.status?.numberReady ?? 0, d.status?.desiredNumberScheduled ?? null);
  for (const c of input.cronjobs)
    at(c)?.workloads.push({
      kind: "CronJob", name: c.metadata?.name ?? "", ready: null, desired: null,
      images: images(c.spec?.jobTemplate?.spec?.template), managedBy: owner(c), schedule: c.spec?.schedule,
    });
  for (const s of input.services)
    at(s)?.services.push({
      name: s.metadata?.name ?? "", type: s.spec?.type ?? "ClusterIP",
      ports: (s.spec?.ports ?? []).map((p) => `${p.port}/${p.protocol ?? "TCP"}${p.targetPort !== undefined && p.targetPort !== p.port ? `→${p.targetPort}` : ""}`),
    });
  for (const i of input.ingresses)
    at(i)?.ingresses.push({ name: i.metadata?.name ?? "", hosts: (i.spec?.rules ?? []).map((r) => r.host).filter((h): h is string => !!h) });
  const namespaces = [...byNs.values()].sort((a, b) => Number(a.system) - Number(b.system) || a.name.localeCompare(b.name));
  return { scanned: { namespaces: namespaces.length, complete: input.complete }, namespaces };
}
export type Inventory = ReturnType<typeof shapeInventory>;

const owner = (m: ManagedBy): string =>
  m.type === "helmrelease" || m.type === "kustomization" ? `${m.type} ${m.namespace}/${m.name}` : m.type;

/**
 * The whole-cluster answer: one line per workload, owner included, Ingress hosts — no images,
 * replicas or ports. The agent compacts every tool result to 8000 chars (MAX_TOOL_RESULT_CHARS),
 * and the full inventory of the live 21-namespace cluster was 16 379: an overview cut there loses
 * namespaces from its middle and still reads as complete. This shape was 4 247 on the same cluster.
 * ponytail: ~200 workloads before it reaches the cap too; page by namespace if a cluster gets there.
 */
export function overviewOf(inv: Inventory) {
  return {
    scanned: inv.scanned,
    detail: "Overview only. Call again with `namespace` for images, ready/desired, Services and ports, CronJob schedules.",
    namespaces: inv.namespaces.map((n) => ({
      name: n.name,
      system: n.system,
      workloads: n.workloads.map((w) => `${w.kind} ${w.name} — ${owner(w.managedBy)}`),
      hosts: n.ingresses.flatMap((i) => i.hosts),
    })),
  };
}

const InventoryInputSchema = z.object({
  namespace: blankToUndefined(z.string().min(1).optional()),
  // Full detail for every namespace. Off by default for a whole-cluster call — see overviewOf.
  detail: z.boolean().optional(),
});

export const clusterInventory = (raw: unknown) => {
  const { namespace, detail } = InventoryInputSchema.parse(raw);
  return withUpstream("kubernetes", "Failed to read the cluster inventory", async () => {
    const core = getApi(k8s.CoreV1Api), apps = getApi(k8s.AppsV1Api), batch = getApi(k8s.BatchV1Api), net = getApi(k8s.NetworkingV1Api);
    type P<T> = Promise<{ items: T[]; metadata?: { _continue?: string } }>;
    const scan = <T>(all: (o: { limit: number; _continue?: string }) => P<T>, one: (o: { namespace: string; limit: number; _continue?: string }) => P<T>) =>
      listAll<T>((o) => (namespace ? one({ ...o, namespace }) : all(o)));
    const [nsList, deps, sts, dss, crons, svcs, ings] = await Promise.all([
      namespace ? Promise.resolve({ items: [{ metadata: { name: namespace } }] as Obj[], complete: true }) : listAll<Obj>((o) => core.listNamespace(o) as P<Obj>),
      scan<WorkloadObj>((o) => apps.listDeploymentForAllNamespaces(o) as P<WorkloadObj>, (o) => apps.listNamespacedDeployment(o) as P<WorkloadObj>),
      scan<WorkloadObj>((o) => apps.listStatefulSetForAllNamespaces(o) as P<WorkloadObj>, (o) => apps.listNamespacedStatefulSet(o) as P<WorkloadObj>),
      scan<WorkloadObj>((o) => apps.listDaemonSetForAllNamespaces(o) as P<WorkloadObj>, (o) => apps.listNamespacedDaemonSet(o) as P<WorkloadObj>),
      scan<CronObj>((o) => batch.listCronJobForAllNamespaces(o) as P<CronObj>, (o) => batch.listNamespacedCronJob(o) as P<CronObj>),
      scan<ServiceObj>((o) => core.listServiceForAllNamespaces(o) as P<ServiceObj>, (o) => core.listNamespacedService(o) as P<ServiceObj>),
      scan<IngressObj>((o) => net.listIngressForAllNamespaces(o) as P<IngressObj>, (o) => net.listNamespacedIngress(o) as P<IngressObj>),
    ]);
    // Best effort: the ServiceAccount may not read Flux CRs. Refused = no paths, never an error.
    const kustomizations = await getApi(k8s.CustomObjectsApi)
      .listCustomObjectForAllNamespaces({ group: "kustomize.toolkit.fluxcd.io", version: "v1", plural: "kustomizations" })
      .then((r) => (r as { items?: KustomizationObj[] }).items ?? [])
      .catch(() => null);
    const inv = shapeInventory({
      namespaces: nsList.items.map((n) => n.metadata?.name).filter((n): n is string => !!n),
      deployments: deps.items, statefulsets: sts.items, daemonsets: dss.items,
      cronjobs: crons.items, services: svcs.items, ingresses: ings.items,
      kustomizations,
      complete: [nsList, deps, sts, dss, crons, svcs, ings].every((l) => l.complete),
    });
    return (detail ?? !!namespace) ? inv : overviewOf(inv);
  });
};
