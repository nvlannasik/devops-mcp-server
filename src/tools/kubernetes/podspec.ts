/**
 * What a pod spec REFERS TO, by name. Shared by two tools that ask opposite questions of it:
 * `k8s_find_unused_resources` asks "does anything point at this object", `k8s_correlate_pods`
 * asks "do these pods point at the same one".
 *
 * The walk is the part that is easy to get wrong — a reference hides in a projected volume, an
 * `envFrom`, a single `env[].valueFrom`, an `imagePullSecrets` — and getting it wrong is what
 * makes the unused scan recommend deleting live config. One walker, one place.
 */

interface EnvSource {
  configMapRef?: { name?: string };
  secretRef?: { name?: string };
}
interface EnvVar {
  name?: string;
  valueFrom?: { configMapKeyRef?: { name?: string }; secretKeyRef?: { name?: string } };
}
export interface ContainerLike {
  name?: string;
  image?: string;
  env?: EnvVar[];
  envFrom?: EnvSource[];
}
export interface PodSpecLike {
  nodeName?: string;
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

/** Bare names, not namespaced — a pod can only reference objects in its own namespace. */
export interface SpecRefs {
  configMaps: Set<string>;
  secrets: Set<string>;
  pvcs: Set<string>;
  serviceAccount?: string;
}

export function refsOfSpec(spec: PodSpecLike): SpecRefs {
  const refs: SpecRefs = {
    configMaps: new Set(),
    secrets: new Set(),
    pvcs: new Set(),
    serviceAccount: spec.serviceAccountName ?? spec.serviceAccount,
  };
  const add = (set: Set<string>, name?: string) => {
    if (name) set.add(name);
  };
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
  for (const c of containersOf(spec)) {
    for (const e of c.envFrom ?? []) {
      add(refs.configMaps, e.configMapRef?.name);
      add(refs.secrets, e.secretRef?.name);
    }
    for (const e of c.env ?? []) {
      add(refs.configMaps, e.valueFrom?.configMapKeyRef?.name);
      add(refs.secrets, e.valueFrom?.secretKeyRef?.name);
    }
  }
  return refs;
}

export const containersOf = (spec: PodSpecLike): ContainerLike[] => [
  ...(spec.initContainers ?? []),
  ...(spec.containers ?? []),
];
