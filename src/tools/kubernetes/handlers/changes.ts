// Change timeline — "what changed in this namespace before the alert". The pure half: every
// function here takes plain objects, so the decisions (what counts as a change, what a secret
// renders as) are tested without a cluster. The k8s reads are in changes-handler.ts.
//
// The diff is over the POD TEMPLATE, not the image tag: in this cluster every revision of
// checkout-gateway runs `:latest`, so a tag diff says "nothing changed" about a real rollout.

export interface FieldDiff { field: string; from: string; to: string }
export interface Change {
  at: string;
  source: "rollout" | "helm" | "config";
  kind: "spec-change" | "restart" | "chart-upgrade" | "values-changed" | "config-updated" | "created";
  workload: string;
  revision?: string;
  diff?: FieldDiff[];
}
export interface Window { from: Date; to: Date }

type EnvVar = {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: { name?: string; key?: string };
    configMapKeyRef?: { name?: string; key?: string };
    fieldRef?: { fieldPath?: string };
  };
};
type Container = {
  name: string;
  image?: string;
  command?: string[];
  args?: string[];
  env?: EnvVar[];
  envFrom?: Array<{ configMapRef?: { name?: string } }>;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  readinessProbe?: unknown;
  livenessProbe?: unknown;
};
export interface PodTemplate {
  metadata?: { annotations?: Record<string, string> };
  spec?: {
    containers?: Container[];
    volumes?: Array<{ name?: string; configMap?: { name?: string }; projected?: { sources?: Array<{ configMap?: { name?: string } }> } }>;
  };
}
export interface Revision { revision: number; at: string; template: PodTemplate }
export interface HelmHistoryEntry { version?: number; chartVersion?: string; configDigest?: string; lastDeployed?: string }
export interface ConfigMapMeta { name: string; managedFields?: Array<{ time?: string }> }

const ABSENT = "(none)";
const RESTARTED_AT = "kubectl.kubernetes.io/restartedAt";
const json = (v: unknown): string | undefined => (v === undefined ? undefined : JSON.stringify(v));
const inWindow = (at: string | undefined, w: Window): boolean => {
  const t = at ? Date.parse(at) : NaN;
  return t >= w.from.getTime() && t <= w.to.getTime();
};

// A secret's VALUE never leaves this function — only where it comes from.
function envValue(e: EnvVar): string {
  if (e.value !== undefined) return e.value;
  const f = e.valueFrom;
  if (f?.secretKeyRef) return `secret:${f.secretKeyRef.name}/${f.secretKeyRef.key}`;
  if (f?.configMapKeyRef) return `configmap:${f.configMapKeyRef.name}/${f.configMapKeyRef.key}`;
  if (f?.fieldRef) return `field:${f.fieldRef.fieldPath}`;
  return "(from source)";
}

export function diffPodTemplates(prev: PodTemplate, next: PodTemplate): FieldDiff[] {
  const out: FieldDiff[] = [];
  const add = (field: string, a: string | undefined, b: string | undefined) => {
    if (a !== b) out.push({ field, from: a ?? ABSENT, to: b ?? ABSENT });
  };
  const byName = (t: PodTemplate) => new Map((t.spec?.containers ?? []).map((c) => [c.name, c]));
  const p = byName(prev);
  const n = byName(next);
  for (const name of new Set([...p.keys(), ...n.keys()])) {
    const a = p.get(name);
    const b = n.get(name);
    if (!a || !b) {
      add(`container ${name}`, a ? "present" : undefined, b ? "present" : undefined);
      continue;
    }
    add(`${name}.image`, a.image, b.image);
    add(`${name}.command`, json(a.command), json(b.command));
    add(`${name}.args`, json(a.args), json(b.args));
    const ea = new Map((a.env ?? []).map((e) => [e.name, envValue(e)]));
    const eb = new Map((b.env ?? []).map((e) => [e.name, envValue(e)]));
    for (const k of new Set([...ea.keys(), ...eb.keys()])) add(`${name}.env.${k}`, ea.get(k), eb.get(k));
    for (const side of ["requests", "limits"] as const) {
      const ra = a.resources?.[side] ?? {};
      const rb = b.resources?.[side] ?? {};
      for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) add(`${name}.resources.${side}.${k}`, ra[k], rb[k]);
    }
    add(`${name}.readinessProbe`, json(a.readinessProbe), json(b.readinessProbe));
    add(`${name}.livenessProbe`, json(a.livenessProbe), json(b.livenessProbe));
  }
  return out;
}

// ponytail: `at` is the revision object's creationTimestamp, so a rollback that REUSES an old
// ReplicaSet (it only bumps the revision annotation) is invisible here. Read the Deployment's
// managedFields time for the revision annotation if that case shows up.
export function rolloutChanges(workload: string, revisions: Revision[], w: Window): Change[] {
  const sorted = [...revisions].sort((a, b) => a.revision - b.revision);
  const out: Change[] = [];
  sorted.forEach((r, i) => {
    if (!inWindow(r.at, w)) return;
    const base = { at: r.at, source: "rollout" as const, workload, revision: String(r.revision) };
    const prev = sorted[i - 1];
    if (!prev) {
      out.push({ ...base, kind: r.revision === 1 ? "created" : "spec-change" });
      return;
    }
    const diff = diffPodTemplates(prev.template, r.template);
    if (diff.length > 0) out.push({ ...base, kind: "spec-change", diff });
    else if (prev.template.metadata?.annotations?.[RESTARTED_AT] !== r.template.metadata?.annotations?.[RESTARTED_AT]) out.push({ ...base, kind: "restart" });
    else out.push({ ...base, kind: "spec-change" });
  });
  return out.reverse();
}

// Flux keeps status.history newest first.
export function helmChanges(hr: string, history: HelmHistoryEntry[], w: Window): Change[] {
  const out: Change[] = [];
  history.forEach((e, i) => {
    if (!inWindow(e.lastDeployed, w)) return;
    const base = { at: e.lastDeployed!, source: "helm" as const, workload: `HelmRelease/${hr}`, revision: e.version === undefined ? undefined : String(e.version) };
    const older = history[i + 1];
    if (!older) out.push({ ...base, kind: "created" });
    else if (older.chartVersion !== e.chartVersion) out.push({ ...base, kind: "chart-upgrade", diff: [{ field: "chart", from: older.chartVersion ?? ABSENT, to: e.chartVersion ?? ABSENT }] });
    else if (older.configDigest !== e.configDigest) out.push({ ...base, kind: "values-changed" });
  });
  return out;
}

export function referencedConfigMaps(templates: PodTemplate[]): Set<string> {
  const names = new Set<string>();
  for (const t of templates) {
    for (const c of t.spec?.containers ?? []) {
      for (const e of c.env ?? []) if (e.valueFrom?.configMapKeyRef?.name) names.add(e.valueFrom.configMapKeyRef.name);
      for (const f of c.envFrom ?? []) if (f.configMapRef?.name) names.add(f.configMapRef.name);
    }
    for (const v of t.spec?.volumes ?? []) {
      if (v.configMap?.name) names.add(v.configMap.name);
      for (const s of v.projected?.sources ?? []) if (s.configMap?.name) names.add(s.configMap.name);
    }
  }
  return names;
}

// Kubernetes keeps no previous content, so a ConfigMap change is a time and nothing else.
// `referenced` null = the rollout source was unread, so every ConfigMap in the namespace counts.
export function configChanges(cms: ConfigMapMeta[], referenced: Set<string> | null, w: Window): Change[] {
  const out: Change[] = [];
  for (const cm of cms) {
    if (referenced && !referenced.has(cm.name)) continue;
    const latest = (cm.managedFields ?? []).map((f) => f.time).filter((t): t is string => !!t).sort().at(-1);
    if (inWindow(latest, w)) out.push({ at: latest!, source: "config", kind: "config-updated", workload: `ConfigMap/${cm.name}` });
  }
  return out;
}
