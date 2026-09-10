import { z } from "zod";
import { getApi, k8s, listAll } from "../kubernetes/client.js";
import { withUpstream } from "../../utils/errors/index.js";

/**
 * "What is nobody using?" — the kor (github.com/yonahd/kor) question, answered against the API
 * server this process already talks to instead of shipping a Go binary into the image.
 *
 * One rule shapes everything below: a false "unused" is a delete recommendation for something
 * live. So references are collected from pod TEMPLATES (Deployment/StatefulSet/DaemonSet/Job/
 * CronJob) as well as from running pods — scanning pods alone calls every ConfigMap of a
 * scaled-to-zero Deployment garbage, which is exactly the mistake that gets someone paged.
 */

interface EnvSource {
  configMapRef?: { name?: string };
  secretRef?: { name?: string };
}
interface EnvVar {
  valueFrom?: { configMapKeyRef?: { name?: string }; secretKeyRef?: { name?: string } };
}
export interface ContainerLike {
  env?: EnvVar[];
  envFrom?: EnvSource[];
}
export interface PodSpecLike {
  serviceAccountName?: string;
  serviceAccount?: string;
  containers?: ContainerLike[];
  initContainers?: ContainerLike[];
  imagePullSecrets?: Array<{ name?: string }>;
  volumes?: Array<{
    configMap?: { name?: string };
    secret?: { secretName?: string };
    persistentVolumeClaim?: { claimName?: string };
    projected?: { sources?: Array<{ configMap?: { name?: string }; secret?: { name?: string } }> };
  }>;
}

export interface Meta {
  namespace: string;
  name: string;
}
export interface SecretLike extends Meta {
  type?: string;
}
export interface ServiceLike extends Meta {
  type?: string;
  addresses: number;
}
export interface ServiceAccountLike extends Meta {
  secrets?: string[];
  imagePullSecrets?: string[];
}
export interface PvcLike extends Meta {
  phase?: string;
  capacity?: string;
}
export interface WorkloadLike extends Meta {
  kind: string;
  /** Deployment/StatefulSet: spec.replicas. DaemonSet: status.desiredNumberScheduled. */
  replicas: number;
}

export interface UnusedSnapshot {
  /** Running pods AND every workload pod template — both are reference sources. */
  podSpecs: Array<{ namespace: string; spec: PodSpecLike }>;
  configMaps: Meta[];
  secrets: SecretLike[];
  pvcs: PvcLike[];
  serviceAccounts: ServiceAccountLike[];
  services: ServiceLike[];
  workloads: WorkloadLike[];
  /** "namespace/name" of every Secret an Ingress names for TLS. */
  ingressSecrets: string[];
}

const key = (namespace: string, name: string) => `${namespace}/${name}`;

export interface Refs {
  configMaps: Set<string>;
  secrets: Set<string>;
  pvcs: Set<string>;
  serviceAccounts: Set<string>;
}

/** exported for the test — the whole correctness of this tool is "did we find the reference?" */
export function collectRefs(specs: Array<{ namespace: string; spec: PodSpecLike }>): Refs {
  const refs: Refs = {
    configMaps: new Set(),
    secrets: new Set(),
    pvcs: new Set(),
    serviceAccounts: new Set(),
  };
  for (const { namespace, spec } of specs) {
    const add = (set: Set<string>, name?: string) => {
      if (name) set.add(key(namespace, name));
    };
    add(refs.serviceAccounts, spec.serviceAccountName ?? spec.serviceAccount);
    for (const v of spec.volumes ?? []) {
      add(refs.configMaps, v.configMap?.name);
      add(refs.secrets, v.secret?.secretName);
      add(refs.pvcs, v.persistentVolumeClaim?.claimName);
      // A projected volume is where the interesting ConfigMaps hide once anything mounts a
      // service-account token alongside its own config.
      for (const s of v.projected?.sources ?? []) {
        add(refs.configMaps, s.configMap?.name);
        add(refs.secrets, s.secret?.name);
      }
    }
    for (const ps of spec.imagePullSecrets ?? []) add(refs.secrets, ps.name);
    for (const c of [...(spec.initContainers ?? []), ...(spec.containers ?? [])]) {
      for (const e of c.envFrom ?? []) {
        add(refs.configMaps, e.configMapRef?.name);
        add(refs.secrets, e.secretRef?.name);
      }
      for (const e of c.env ?? []) {
        add(refs.configMaps, e.valueFrom?.configMapKeyRef?.name);
        add(refs.secrets, e.valueFrom?.secretKeyRef?.name);
      }
    }
  }
  return refs;
}

// Kubernetes and the usual mesh/CA controllers write these into every namespace themselves.
// Reporting them is noise the on-call has to re-learn to ignore on every single run.
const AUTO_CONFIGMAPS = new Set(["kube-root-ca.crt", "istio-ca-root-cert", "openshift-service-ca.crt"]);

// helm.sh/release.v1 is Helm's own release history — deleting one breaks `helm rollback`, and
// it is "unreferenced" by construction. Token secrets belong to the ServiceAccount controller.
const MANAGED_SECRET_TYPES = new Set(["helm.sh/release.v1", "kubernetes.io/service-account-token"]);

export interface Finding {
  kind: string;
  namespace: string;
  name: string;
  reason: string;
}

// Per KIND, not per response: a flat cap would silently drop a whole category (the two orphaned
// PVCs) behind forty ConfigMaps. Counts are never capped, only the listings.
const PER_KIND_CAP = 15;

/** exported for the test */
export function shapeUnused(snap: UnusedSnapshot, opts: { namespaces: number; complete: boolean }) {
  const refs = collectRefs(snap.podSpecs);

  // A ServiceAccount keeps its own pull/token secrets alive even when no pod names them.
  for (const sa of snap.serviceAccounts) {
    for (const n of [...(sa.secrets ?? []), ...(sa.imagePullSecrets ?? [])]) {
      refs.secrets.add(key(sa.namespace, n));
    }
  }
  for (const s of snap.ingressSecrets) refs.secrets.add(s);

  const byKind = new Map<string, Finding[]>();
  const push = (f: Finding) => {
    const list = byKind.get(f.kind) ?? [];
    list.push(f);
    byKind.set(f.kind, list);
  };

  for (const p of snap.pvcs) {
    if (refs.pvcs.has(key(p.namespace, p.name))) continue;
    push({
      kind: "PersistentVolumeClaim",
      namespace: p.namespace,
      name: p.name,
      reason: `not mounted by any pod or workload template (phase ${p.phase ?? "unknown"}${p.capacity ? `, ${p.capacity}` : ""}) — this one costs storage every day it survives`,
    });
  }

  for (const s of snap.services) {
    // ExternalName is a DNS alias; it never has endpoints and is not unused for lacking them.
    if (s.type === "ExternalName") continue;
    if (s.namespace === "default" && s.name === "kubernetes") continue;
    if (s.addresses > 0) continue;
    push({
      kind: "Service",
      namespace: s.namespace,
      name: s.name,
      reason: "no endpoint addresses at all (ready or not-ready) — either nothing matches its selector, or every backing pod is gone",
    });
  }

  for (const w of snap.workloads) {
    if (w.replicas !== 0) continue;
    push({
      kind: w.kind,
      namespace: w.namespace,
      name: w.name,
      reason:
        w.kind === "DaemonSet"
          ? "desired count is 0 — its nodeSelector/affinity matches no node in this cluster"
          : "scaled to 0 replicas — running nothing, still holding its config, PVCs and quota",
    });
  }

  for (const c of snap.configMaps) {
    if (AUTO_CONFIGMAPS.has(c.name)) continue;
    if (refs.configMaps.has(key(c.namespace, c.name))) continue;
    push({
      kind: "ConfigMap",
      namespace: c.namespace,
      name: c.name,
      reason: "no pod or workload template mounts it or reads it via env/envFrom",
    });
  }

  for (const s of snap.secrets) {
    if (s.type && MANAGED_SECRET_TYPES.has(s.type)) continue;
    if (refs.secrets.has(key(s.namespace, s.name))) continue;
    push({
      kind: "Secret",
      namespace: s.namespace,
      name: s.name,
      reason: "no pod, workload template, ServiceAccount or Ingress TLS block names it",
    });
  }

  for (const sa of snap.serviceAccounts) {
    if (sa.name === "default") continue;
    if (refs.serviceAccounts.has(key(sa.namespace, sa.name))) continue;
    push({
      kind: "ServiceAccount",
      namespace: sa.namespace,
      name: sa.name,
      reason: "no pod or workload template runs as it (its RoleBindings are dead weight too)",
    });
  }

  // Storage first, then broken routing, then idle workloads, then config leftovers: the order
  // an on-call would act in, so the head of the list is the part worth reading.
  const KIND_ORDER = [
    "PersistentVolumeClaim",
    "Service",
    "Deployment",
    "StatefulSet",
    "DaemonSet",
    "ConfigMap",
    "Secret",
    "ServiceAccount",
  ];

  const counts: Record<string, number> = {};
  const findings: Finding[] = [];
  let truncated = false;
  for (const kind of KIND_ORDER) {
    const list = (byKind.get(kind) ?? []).sort((a, b) =>
      `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`)
    );
    if (!list.length) continue;
    counts[kind] = list.length;
    if (list.length > PER_KIND_CAP) truncated = true;
    findings.push(...list.slice(0, PER_KIND_CAP));
  }

  return {
    scanned: { namespaces: opts.namespaces, complete: opts.complete },
    checked: {
      configMaps: snap.configMaps.length,
      secrets: snap.secrets.length,
      persistentVolumeClaims: snap.pvcs.length,
      serviceAccounts: snap.serviceAccounts.length,
      services: snap.services.length,
      workloads: snap.workloads.length,
      referenceSources: snap.podSpecs.length,
    },
    unusedTotal: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    findings,
    truncated,
    note:
      `References come from running pods plus Deployment/StatefulSet/DaemonSet/Job/CronJob pod templates. ` +
      `Anything consumed another way — an operator reading a ConfigMap through the API, a CRD field, a ` +
      `\`kubectl create --from-file\` at deploy time — will show up here and is NOT safe to delete. ` +
      `This is a review list, not a delete list: name the owner before proposing removal.` +
      (opts.complete ? "" : " SCAN INCOMPLETE — hit its item ceiling, so some references were never read; treat every finding as unverified."),
  };
}

// DNS-1123 label. Doubles as the guard that keeps a caller-supplied namespace out of anything
// it should not reach.
const NS_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const UnusedInput = z.object({
  namespace: z.string().regex(NS_RE).optional(),
  include_system_namespaces: z.boolean().default(false),
});

const podSpec = (spec: unknown): PodSpecLike => (spec ?? {}) as PodSpecLike;

export const findUnusedResources = (input: unknown) => {
  const { namespace, include_system_namespaces } = UnusedInput.parse(input);

  return withUpstream("kubernetes", "Failed to scan for unused resources", async () => {
    const core = getApi(k8s.CoreV1Api);
    const apps = getApi(k8s.AppsV1Api);
    const batch = getApi(k8s.BatchV1Api);
    const net = getApi(k8s.NetworkingV1Api);

    // Always cluster-wide, then filtered in memory. One code path instead of two, and the
    // namespaced case is a `.filter()` rather than a second set of thirteen call sites.
    const [pods, deploys, sets, daemons, jobs, cronjobs, cms, secrets, pvcs, sas, svcs, eps, ingresses] =
      await Promise.all([
        listAll((o) => core.listPodForAllNamespaces(o)),
        listAll((o) => apps.listDeploymentForAllNamespaces(o)),
        listAll((o) => apps.listStatefulSetForAllNamespaces(o)),
        listAll((o) => apps.listDaemonSetForAllNamespaces(o)),
        listAll((o) => batch.listJobForAllNamespaces(o)),
        listAll((o) => batch.listCronJobForAllNamespaces(o)),
        listAll((o) => core.listConfigMapForAllNamespaces(o)),
        listAll((o) => core.listSecretForAllNamespaces(o)),
        listAll((o) => core.listPersistentVolumeClaimForAllNamespaces(o)),
        listAll((o) => core.listServiceAccountForAllNamespaces(o)),
        listAll((o) => core.listServiceForAllNamespaces(o)),
        listAll((o) => core.listEndpointsForAllNamespaces(o)),
        listAll((o) => net.listIngressForAllNamespaces(o)),
      ]);

    const complete = [pods, deploys, sets, daemons, jobs, cronjobs, cms, secrets, pvcs, sas, svcs, eps, ingresses]
      .every((r) => r.complete);

    const inScope = (ns?: string): boolean => {
      if (!ns) return false;
      if (namespace) return ns === namespace;
      return include_system_namespaces || !ns.startsWith("kube-");
    };
    const meta = <T extends { metadata?: { name?: string; namespace?: string } }>(items: T[]) =>
      items.filter((i) => inScope(i.metadata?.namespace));

    // Reference sources are NOT namespace-filtered on purpose: a cross-namespace scope would
    // still be wrong, but within scope every template must be seen or the index lies.
    const podSpecs = [
      ...meta(pods.items).map((p) => ({ namespace: p.metadata!.namespace!, spec: podSpec(p.spec) })),
      ...meta(deploys.items).map((d) => ({ namespace: d.metadata!.namespace!, spec: podSpec(d.spec?.template?.spec) })),
      ...meta(sets.items).map((s) => ({ namespace: s.metadata!.namespace!, spec: podSpec(s.spec?.template?.spec) })),
      ...meta(daemons.items).map((d) => ({ namespace: d.metadata!.namespace!, spec: podSpec(d.spec?.template?.spec) })),
      ...meta(jobs.items).map((j) => ({ namespace: j.metadata!.namespace!, spec: podSpec(j.spec?.template?.spec) })),
      ...meta(cronjobs.items).map((c) => ({
        namespace: c.metadata!.namespace!,
        spec: podSpec(c.spec?.jobTemplate?.spec?.template?.spec),
      })),
    ];

    const addressesBySvc = new Map<string, number>();
    for (const e of eps.items) {
      const n = (e.subsets ?? []).reduce(
        (sum, s) => sum + (s.addresses?.length ?? 0) + (s.notReadyAddresses?.length ?? 0),
        0
      );
      addressesBySvc.set(key(e.metadata!.namespace!, e.metadata!.name!), n);
    }

    const ingressSecrets = meta(ingresses.items).flatMap((i) =>
      (i.spec?.tls ?? [])
        .map((t) => t.secretName)
        .filter((n): n is string => !!n)
        .map((n) => key(i.metadata!.namespace!, n))
    );

    const namespaces = new Set(podSpecs.map((p) => p.namespace));
    for (const c of meta(cms.items)) namespaces.add(c.metadata!.namespace!);

    return shapeUnused(
      {
        podSpecs,
        configMaps: meta(cms.items).map((c) => ({ namespace: c.metadata!.namespace!, name: c.metadata!.name! })),
        secrets: meta(secrets.items).map((s) => ({
          namespace: s.metadata!.namespace!,
          name: s.metadata!.name!,
          type: s.type,
        })),
        pvcs: meta(pvcs.items).map((p) => ({
          namespace: p.metadata!.namespace!,
          name: p.metadata!.name!,
          phase: p.status?.phase,
          capacity: p.status?.capacity?.storage ?? p.spec?.resources?.requests?.storage,
        })),
        serviceAccounts: meta(sas.items).map((s) => ({
          namespace: s.metadata!.namespace!,
          name: s.metadata!.name!,
          secrets: (s.secrets ?? []).map((r) => r.name).filter((n): n is string => !!n),
          imagePullSecrets: (s.imagePullSecrets ?? []).map((r) => r.name).filter((n): n is string => !!n),
        })),
        services: meta(svcs.items).map((s) => ({
          namespace: s.metadata!.namespace!,
          name: s.metadata!.name!,
          type: s.spec?.type,
          addresses: addressesBySvc.get(key(s.metadata!.namespace!, s.metadata!.name!)) ?? 0,
        })),
        workloads: [
          ...meta(deploys.items).map((d) => ({
            kind: "Deployment",
            namespace: d.metadata!.namespace!,
            name: d.metadata!.name!,
            replicas: d.spec?.replicas ?? 0,
          })),
          ...meta(sets.items).map((s) => ({
            kind: "StatefulSet",
            namespace: s.metadata!.namespace!,
            name: s.metadata!.name!,
            replicas: s.spec?.replicas ?? 0,
          })),
          ...meta(daemons.items).map((d) => ({
            kind: "DaemonSet",
            namespace: d.metadata!.namespace!,
            name: d.metadata!.name!,
            replicas: d.status?.desiredNumberScheduled ?? 0,
          })),
        ],
        ingressSecrets,
      },
      { namespaces: namespaces.size, complete }
    );
  });
};
