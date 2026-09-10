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
  /** "Certificate/api-tls" when another object controls this one's lifecycle. */
  owner?: string;
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
  /** Set when an ownerReference already explains the object — it never reaches the report. */
  ownerSuppressed?: string;
}

// Per KIND, not per response: a flat cap would silently drop a whole category (the two orphaned
// PVCs) behind forty ConfigMaps. Counts are never capped, only the listings.
const PER_KIND_CAP = 15;

/**
 * Kinds whose finding is a claim about REFERENCES ("nothing names this") — the only claim a
 * custom resource can falsify. A Service with no endpoints or a Deployment at 0 replicas is a
 * claim about STATE, which no CR mention makes untrue, so those are never cross-checked.
 */
export const REFERENCEABLE = new Set(["ConfigMap", "Secret", "PersistentVolumeClaim", "ServiceAccount"]);

/** exported for the test */
export function collectFindings(snap: UnusedSnapshot): Finding[] {
  const refs = collectRefs(snap.podSpecs);

  // A ServiceAccount keeps its own pull/token secrets alive even when no pod names them.
  for (const sa of snap.serviceAccounts) {
    for (const n of [...(sa.secrets ?? []), ...(sa.imagePullSecrets ?? [])]) {
      refs.secrets.add(key(sa.namespace, n));
    }
  }
  for (const s of snap.ingressSecrets) refs.secrets.add(s);

  const findings: Finding[] = [];
  // An ownerReference is the free half of the cross-check: an object an operator CREATED carries
  // one, its lifecycle follows the owner, and Kubernetes' own garbage collector deletes it when
  // the owner goes. Costs no extra API call — the field was already in the list response. It does
  // NOT cover an operator that merely REFERENCES a hand-made object by name; that is what the
  // CR scan in the handler is for.
  const push = (f: Finding, owner?: string) => {
    findings.push(owner ? { ...f, ownerSuppressed: `owned by ${owner}` } : f);
  };

  for (const p of snap.pvcs) {
    if (refs.pvcs.has(key(p.namespace, p.name))) continue;
    push({
      kind: "PersistentVolumeClaim",
      namespace: p.namespace,
      name: p.name,
      reason: `not mounted by any pod or workload template (phase ${p.phase ?? "unknown"}${p.capacity ? `, ${p.capacity}` : ""}) — this one costs storage every day it survives`,
    }, p.owner);
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
    }, c.owner);
  }

  for (const s of snap.secrets) {
    if (s.type && MANAGED_SECRET_TYPES.has(s.type)) continue;
    if (refs.secrets.has(key(s.namespace, s.name))) continue;
    push({
      kind: "Secret",
      namespace: s.namespace,
      name: s.name,
      reason: "no pod, workload template, ServiceAccount or Ingress TLS block names it",
    }, s.owner);
  }

  for (const sa of snap.serviceAccounts) {
    if (sa.name === "default") continue;
    if (refs.serviceAccounts.has(key(sa.namespace, sa.name))) continue;
    push({
      kind: "ServiceAccount",
      namespace: sa.namespace,
      name: sa.name,
      reason: "no pod or workload template runs as it (its RoleBindings are dead weight too)",
    }, sa.owner);
  }

  return findings;
}

export interface CrossCheck {
  /** false when the caller turned it off — the note then says the claim is unverified. */
  enabled: boolean;
  crdsScanned: number;
  /** CRDs the ServiceAccount may not read. Each is a blind spot, so each is named. */
  crdsUnreadable: string[];
  /** "namespace/name" -> the custom resource that mentioned it. */
  mentions: Map<string, string>;
}

/** exported for the test */
export function assembleUnused(
  all: Finding[],
  opts: { namespaces: number; complete: boolean; checked: Record<string, number>; crossCheck?: CrossCheck }
) {
  const cc = opts.crossCheck;

  // An object a CR names is live, whatever the native scan concluded. Dropped from findings
  // rather than annotated: a "probably fine" row in a cleanup list is a row someone eventually
  // acts on anyway.
  const suppressed: Array<{ kind: string; namespace: string; name: string; keptBy: string }> = [];
  const findings = all.filter((f) => {
    const by = f.ownerSuppressed ?? (REFERENCEABLE.has(f.kind) ? cc?.mentions.get(`${f.namespace}/${f.name}`) : undefined);
    if (!by) return true;
    suppressed.push({ kind: f.kind, namespace: f.namespace, name: f.name, keptBy: by });
    return false;
  });

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

  const byKind = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byKind.get(f.kind) ?? [];
    list.push(f);
    byKind.set(f.kind, list);
  }

  const counts: Record<string, number> = {};
  const shown: Finding[] = [];
  let truncated = false;
  for (const kind of KIND_ORDER) {
    const list = (byKind.get(kind) ?? []).sort((a, b) =>
      `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`)
    );
    if (!list.length) continue;
    counts[kind] = list.length;
    if (list.length > PER_KIND_CAP) truncated = true;
    shown.push(...list.slice(0, PER_KIND_CAP));
  }

  const cross = cc
    ? {
        enabled: cc.enabled,
        crdsScanned: cc.crdsScanned,
        crdsUnreadable: cc.crdsUnreadable.slice(0, 20),
        suppressedTotal: suppressed.length,
        suppressed: suppressed.slice(0, PER_KIND_CAP),
      }
    : undefined;

  // The claim this tool is allowed to make depends entirely on what the cross-check saw, so the
  // note is assembled from that rather than written once. An unreadable CRD is a blind spot and
  // must downgrade the wording — "not referenced" and "not referenced as far as I could look"
  // are different sentences, and only one of them survives contact with an operator.
  const blind = cc && cc.crdsUnreadable.length > 0;
  const note =
    `References come from running pods, every Deployment/StatefulSet/DaemonSet/Job/CronJob pod ` +
    `template, and each object's ownerReferences. ` +
    (cc?.enabled && cc.crdsScanned === 0 && cc.crdsUnreadable.length === 0
      ? `No ConfigMap/Secret/PVC/ServiceAccount candidate survived the native scan, so there was nothing ` +
        `left for the custom-resource cross-check to disprove.`
      : !cc || !cc.enabled
      ? `Custom resources were NOT cross-checked (cross_check_crds is off), so a ConfigMap or Secret an ` +
        `operator names in its CR spec is in this list and must not be removed.`
      : blind
        ? `${cc.crdsScanned} CRD kinds were scanned for mentions, but ${cc.crdsUnreadable.length} could NOT be ` +
          `read (RBAC): ${cc.crdsUnreadable.slice(0, 5).join(", ")}. Anything those operators reference still ` +
          `looks unused here — say the cross-check was partial.`
        : `All ${cc.crdsScanned} CRD kinds in the cluster were scanned for mentions of these names, so an ` +
          `operator-referenced object has already been removed from the list.`) +
    ` Still a review list, not a delete list: an object read by name at runtime (a \`kubectl create ` +
    `--from-file\`, an app reading its own ConfigMap through the API) leaves no trace anywhere. Name ` +
    `the owner before proposing removal.` +
    (opts.complete ? "" : " SCAN INCOMPLETE — hit its item ceiling, so some references were never read; treat every finding as unverified.");

  return {
    scanned: { namespaces: opts.namespaces, complete: opts.complete },
    checked: opts.checked,
    unusedTotal: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    findings: shown,
    truncated,
    crossCheck: cross,
    note,
  };
}

/** exported for the test — kept so a caller with no cross-check gets the whole scan in one call */
export const shapeUnused = (
  snap: UnusedSnapshot,
  opts: { namespaces: number; complete: boolean; crossCheck?: CrossCheck }
) => assembleUnused(collectFindings(snap), { ...opts, checked: checkedOf(snap) });

export const checkedOf = (snap: UnusedSnapshot) => ({
  configMaps: snap.configMaps.length,
  secrets: snap.secrets.length,
  persistentVolumeClaims: snap.pvcs.length,
  serviceAccounts: snap.serviceAccounts.length,
  services: snap.services.length,
  workloads: snap.workloads.length,
  referenceSources: snap.podSpecs.length,
});

// managedFields is a large, purely mechanical audit trail — scanning it finds nothing and costs
// the walk on every object. Everything else stays in scope, including annotations, because
// last-applied-configuration is exactly where a reference hides.
function* strings(v: unknown): Generator<string> {
  if (typeof v === "string") {
    yield v;
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) yield* strings(x);
    return;
  }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "managedFields") continue;
      yield k;
      yield* strings(x);
    }
  }
}

/**
 * Does any custom resource mention one of these names? Matching is on bare string equality
 * against every key and every string leaf of the CR, which is coarse on purpose: an operator's
 * schema is its own, so `spec.configMapRef.name`, `spec.tls.secretName` and
 * `spec.template.volumes[0].configMap.name` cannot be enumerated ahead of time. A coincidental
 * match keeps an object that was in fact unused — the harmless direction. The reverse, a missed
 * reference, is a delete recommendation for live config.
 *
 * exported for the test
 */
export function mentionedNames(
  docs: Array<{ namespace?: string; source: string; obj: unknown }>,
  wanted: Map<string, Set<string>>,
  into: Map<string, string> = new Map()
): Map<string, string> {
  const anyNamespace = new Set<string>();
  for (const set of wanted.values()) for (const n of set) anyNamespace.add(n);

  for (const { namespace, source, obj } of docs) {
    const scope = namespace ? wanted.get(namespace) : anyNamespace;
    if (!scope?.size) continue;
    for (const str of strings(obj)) {
      if (!scope.has(str)) continue;
      if (namespace) {
        if (!into.has(`${namespace}/${str}`)) into.set(`${namespace}/${str}`, source);
        continue;
      }
      // A cluster-scoped CR (ClusterIssuer, a Prometheus rule) can name an object in any
      // namespace, so the name is protected wherever it is a candidate. Over-keeping beats
      // over-deleting.
      for (const [ns, set] of wanted) {
        if (set.has(str) && !into.has(`${ns}/${str}`)) into.set(`${ns}/${str}`, source);
      }
    }
  }
  return into;
}

// A cluster with an operator zoo serves well past this; the cap keeps one tool call from turning
// into a hundred list requests. Anything past it is reported as unreadable, never silently cut.
const MAX_CRD_KINDS = 80;
const CRD_BATCH = 8;

async function crossCheckCustomResources(wanted: Map<string, Set<string>>): Promise<CrossCheck> {
  const co = getApi(k8s.CustomObjectsApi);
  const crds = await getApi(k8s.ApiextensionsV1Api).listCustomResourceDefinition();
  const kinds = crds.items;
  const unreadable: string[] = [];
  const mentions = new Map<string, string>();
  let scanned = 0;

  const targets = kinds.slice(0, MAX_CRD_KINDS).flatMap((crd) => {
    // The storage version is the one guaranteed to hold every object; fall back to any served
    // version so a CRD mid-migration is still scanned rather than skipped.
    const v = crd.spec.versions.find((x) => x.storage && x.served) ?? crd.spec.versions.find((x) => x.served);
    return v ? [{ group: crd.spec.group, version: v.name, plural: crd.spec.names.plural, namespaced: crd.spec.scope === "Namespaced" }] : [];
  });
  for (const over of kinds.slice(MAX_CRD_KINDS)) unreadable.push(`${over.spec.names.plural}.${over.spec.group} (past the ${MAX_CRD_KINDS}-CRD cap)`);

  for (let i = 0; i < targets.length; i += CRD_BATCH) {
    const batch = await Promise.allSettled(
      targets.slice(i, i + CRD_BATCH).map(async (t) => {
        const res = t.namespaced
          ? await co.listCustomObjectForAllNamespaces({ group: t.group, version: t.version, plural: t.plural })
          : await co.listClusterCustomObject({ group: t.group, version: t.version, plural: t.plural });
        return { t, items: ((res as { items?: unknown[] }).items ?? []) };
      })
    );
    for (const [j, r] of batch.entries()) {
      const t = targets[i + j];
      if (r.status === "rejected") {
        // Almost always RBAC: the ServiceAccount is granted named groups, not every group.
        unreadable.push(`${t.plural}.${t.group}`);
        continue;
      }
      scanned++;
      // Folded per batch rather than collected — holding every CR in the cluster in memory to
      // ask one question about each is the version of this that falls over on a big cluster.
      mentionedNames(
        r.value.items.map((item) => {
          const m = (item as { metadata?: { name?: string; namespace?: string } }).metadata;
          return { namespace: m?.namespace, source: `${t.plural}.${t.group}/${m?.namespace ? `${m.namespace}/` : ""}${m?.name}`, obj: item };
        }),
        wanted,
        mentions
      );
    }
  }

  return { enabled: true, crdsScanned: scanned, crdsUnreadable: unreadable, mentions };
}

// DNS-1123 label. Doubles as the guard that keeps a caller-supplied namespace out of anything
// it should not reach.
const NS_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const UnusedInput = z.object({
  namespace: z.string().regex(NS_RE).optional(),
  include_system_namespaces: z.boolean().default(false),
  cross_check_crds: z.boolean().default(true),
});

// "Certificate/api-tls" from the controlling ownerReference, if any.
const ownerOf = (m?: { ownerReferences?: Array<{ kind?: string; name?: string }> }): string | undefined => {
  const o = m?.ownerReferences?.[0];
  return o?.kind ? `${o.kind}/${o.name}` : undefined;
};

const podSpec = (spec: unknown): PodSpecLike => (spec ?? {}) as PodSpecLike;

export const findUnusedResources = (input: unknown) => {
  const { namespace, include_system_namespaces, cross_check_crds } = UnusedInput.parse(input);

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

    const snap: UnusedSnapshot = {
        podSpecs,
        configMaps: meta(cms.items).map((c) => ({ namespace: c.metadata!.namespace!, name: c.metadata!.name!, owner: ownerOf(c.metadata) })),
        secrets: meta(secrets.items).map((s) => ({
          namespace: s.metadata!.namespace!,
          name: s.metadata!.name!,
          type: s.type,
          owner: ownerOf(s.metadata),
        })),
        pvcs: meta(pvcs.items).map((p) => ({
          namespace: p.metadata!.namespace!,
          name: p.metadata!.name!,
          phase: p.status?.phase,
          capacity: p.status?.capacity?.storage ?? p.spec?.resources?.requests?.storage,
          owner: ownerOf(p.metadata),
        })),
        serviceAccounts: meta(sas.items).map((s) => ({
          namespace: s.metadata!.namespace!,
          name: s.metadata!.name!,
          secrets: (s.secrets ?? []).map((r) => r.name).filter((n): n is string => !!n),
          imagePullSecrets: (s.imagePullSecrets ?? []).map((r) => r.name).filter((n): n is string => !!n),
          owner: ownerOf(s.metadata),
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
    };

    const findings = collectFindings(snap);

    // Cross-check only what SURVIVED the native scan and the ownerReference filter. In a healthy
    // cluster that set is empty and the whole CRD pass is skipped — the expensive half runs only
    // when there is actually something to disprove.
    const wanted = new Map<string, Set<string>>();
    for (const f of findings) {
      if (f.ownerSuppressed || !REFERENCEABLE.has(f.kind)) continue;
      const set = wanted.get(f.namespace) ?? new Set<string>();
      set.add(f.name);
      wanted.set(f.namespace, set);
    }

    let crossCheck: CrossCheck | undefined;
    if (!cross_check_crds) {
      crossCheck = { enabled: false, crdsScanned: 0, crdsUnreadable: [], mentions: new Map() };
    } else if (wanted.size > 0) {
      crossCheck = await crossCheckCustomResources(wanted);
    } else {
      // Nothing reference-shaped survived, so there is nothing to disprove — but the caller
      // still needs to know the cross-check was ON, or the note reads as if it had been skipped.
      crossCheck = { enabled: true, crdsScanned: 0, crdsUnreadable: [], mentions: new Map() };
    }

    return assembleUnused(findings, {
      namespaces: namespaces.size,
      complete,
      checked: checkedOf(snap),
      crossCheck,
    });
  });
};
