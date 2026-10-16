// What a workload is CONFIGURED to depend on, from its env (spec 2026-10-16-cluster-onboarding-flow
// §1). Values are read here and nowhere else, and never returned: the output is env NAMES, matched
// Services and host names. userinfo is stripped before any parsing, so a password in a URL is gone
// before a regex sees it. Secrets are never resolved — the ServiceAccount can read them for other
// tools; this path must not.

export interface ContainerEnv {
  env?: Array<{ name: string; value?: string; valueFrom?: { configMapKeyRef?: { name: string; key: string }; secretKeyRef?: unknown } }>;
  envFrom?: Array<{ configMapRef?: { name: string }; secretRef?: unknown }>;
}
export interface EnvDeps {
  dependsOn: Array<{ service: string; namespace: string; via: string; role: "app" | "telemetry" }>;
  externalHosts: Array<{ host: string; via: string }>;
  unresolved: Array<{ host: string; via: string }>;
}
export type HostMatch = { kind: "service"; namespace: string; name: string } | { kind: "unresolved" } | { kind: "external" } | null;

const TELEMETRY_ENV = /^(OTEL_|JAEGER_|ZIPKIN_|PROMETHEUS_|LOKI_)/;
const TELEMETRY_SVC = /(jaeger|tempo|zipkin|otel|opentelemetry|collector|prometheus|loki|fluent|grafana|alertmanager)/i;
// A bare single word is a host only under a name that says it is one — `DB_TYPE=postgres` beside a
// Service named postgres is a value, not a dependency.
const HOSTISH_NAME = /(HOST|ADDR|URL|URI|ENDPOINT|SERVER|BROKER|DSN|SERVICE)/i;
const HOSTNAME = /^(?=.*[a-z])[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function stripUserinfo(value: string): string {
  return value.replace(/(\/\/)[^/@\s]*@/g, "$1");
}

export function hostsIn(value: string): string[] {
  const out: string[] = [];
  for (const token of stripUserinfo(value).split(/[\s,;]+/).filter(Boolean)) {
    let host: string | undefined;
    if (token.includes("://")) {
      try { host = new URL(token).hostname; } catch { host = undefined; }
    } else {
      const noPath = token.split("/")[0] ?? "";
      const m = /^([^:]+)(?::(\d+))?$/.exec(noPath);
      host = m ? m[1] : undefined;
    }
    host = host?.toLowerCase();
    if (host && host.length <= 253 && HOSTNAME.test(host) && !out.includes(host)) out.push(host);
  }
  return out;
}

export function matchHost(host: string, workloadNs: string, services: ReadonlySet<string>, hostishName: boolean): HostMatch {
  const inCluster = /\.svc(\.cluster\.local)?$/.test(host);
  const labels = host.replace(/\.svc(\.cluster\.local)?$/, "").split(".");
  if (labels.length === 1) {
    if (!inCluster && !hostishName) return null;
    if (services.has(`${workloadNs}/${labels[0]}`)) return { kind: "service", namespace: workloadNs, name: labels[0]! };
    return inCluster ? { kind: "unresolved" } : null;
  }
  if (labels.length === 2) {
    const [name, ns] = labels as [string, string];
    if (services.has(`${ns}/${name}`)) return { kind: "service", namespace: ns, name };
    return inCluster ? { kind: "unresolved" } : { kind: "external" };
  }
  return inCluster ? { kind: "unresolved" } : { kind: "external" };
}

/** Every (envName, value) pair the container exposes — literal env and ConfigMap-sourced, never Secrets. */
function* pairs(c: ContainerEnv, ns: string, cms: ReadonlyMap<string, Record<string, string>> | null): Generator<[string, string]> {
  for (const e of c.env ?? []) {
    if (typeof e.value === "string") yield [e.name, e.value];
    const ref = e.valueFrom?.configMapKeyRef; // secretKeyRef is never touched
    if (ref && cms) {
      const v = cms.get(`${ns}/${ref.name}`)?.[ref.key];
      if (typeof v === "string") yield [e.name, v];
    }
  }
  for (const f of c.envFrom ?? []) {
    if (!f.configMapRef || !cms) continue; // secretRef is never touched
    for (const [k, v] of Object.entries(cms.get(`${ns}/${f.configMapRef.name}`) ?? {})) yield [k, v];
  }
}

export function envDeps(
  containers: ContainerEnv[],
  workloadNs: string,
  services: ReadonlySet<string>,
  configMaps: ReadonlyMap<string, Record<string, string>> | null
): EnvDeps {
  const out: EnvDeps = { dependsOn: [], externalHosts: [], unresolved: [] };
  const seen = new Set<string>();
  for (const c of containers) {
    for (const [via, value] of pairs(c, workloadNs, configMaps)) {
      for (const host of hostsIn(value)) {
        const m = matchHost(host, workloadNs, services, HOSTISH_NAME.test(via));
        if (!m) continue;
        const key = `${m.kind}\u0000${via}\u0000${m.kind === "service" ? `${m.namespace}/${m.name}` : host}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (m.kind === "service") {
          const role = TELEMETRY_ENV.test(via) || TELEMETRY_SVC.test(m.name) ? "telemetry" : "app";
          out.dependsOn.push({ service: m.name, namespace: m.namespace, via, role });
        } else if (m.kind === "external") out.externalHosts.push({ host, via });
        else out.unresolved.push({ host, via });
      }
    }
  }
  return out;
}

export function configMapRefs(containers: ContainerEnv[], workloadNs: string): string[] {
  const refs = new Set<string>();
  for (const c of containers) {
    for (const e of c.env ?? []) if (e.valueFrom?.configMapKeyRef) refs.add(`${workloadNs}/${e.valueFrom.configMapKeyRef.name}`);
    for (const f of c.envFrom ?? []) if (f.configMapRef) refs.add(`${workloadNs}/${f.configMapRef.name}`);
  }
  return [...refs];
}
