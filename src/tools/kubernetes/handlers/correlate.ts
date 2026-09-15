import { z } from "zod";
import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { blankToUndefined } from "../schemas.js";
import { refsOfSpec, containersOf, type PodSpecLike } from "../podspec.js";

/**
 * "Eight pods are broken — do they share a cause?"
 *
 * The alert side already groups: one Alertmanager webhook is one investigation. What was
 * missing is the other half — seeing what the members of that group have IN COMMON. To find it
 * today a model has to call k8s_describe_pod eight times and diff the specs in its head, and in
 * the benchmark it reliably does not: the eight-pods-one-cause case failed every attempt, never
 * naming the env var the pods shared.
 *
 * So the diff is done here. Same reasoning as k8s_cluster_health: the model gets the conclusion,
 * not the raw material to re-derive it from.
 *
 * The high-value output is not `shared` — pods of one Deployment share almost everything, which
 * says nothing. It is `uniqueToBroken`: what the failing set shares that the HEALTHY pods in the
 * same namespace do NOT. That is the difference between "these 8 pods read app-config" and
 * "these 8 pods, and only these, read app-config".
 */

interface PodLike {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: Date | string; ownerReferences?: Array<{ kind?: string; name?: string }> };
  spec?: PodSpecLike;
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      ready?: boolean;
      restartCount?: number;
      state?: { waiting?: { reason?: string }; terminated?: { reason?: string } };
      lastState?: { terminated?: { reason?: string } };
    }>;
  };
}

/** Same convention as k8s_cluster_health: readiness, not phase. A CrashLoop pod's phase is Running. */
const isReady = (p: PodLike): boolean => {
  const cs = p.status?.containerStatuses;
  return (cs?.length ?? 0) > 0 && cs!.every((c) => c.ready);
};

const reasonOf = (p: PodLike): string | undefined => {
  for (const c of p.status?.containerStatuses ?? []) {
    const r = c.state?.waiting?.reason ?? c.state?.terminated?.reason ?? c.lastState?.terminated?.reason;
    if (r && r !== "Completed") return r;
  }
  return undefined;
};

/**
 * One pod flattened into comparable `kind=value` facts. Strings, so comparison is set algebra
 * and a new fact type costs one line here and nothing anywhere else.
 */
export function factsOf(p: PodLike): Set<string> {
  const f = new Set<string>();
  const spec = p.spec ?? {};
  const refs = refsOfSpec(spec);

  if (spec.nodeName) f.add(`node=${spec.nodeName}`);
  if (refs.serviceAccount) f.add(`serviceAccount=${refs.serviceAccount}`);
  for (const n of refs.configMaps) f.add(`configMap=${n}`);
  for (const n of refs.secrets) f.add(`secret=${n}`);
  for (const n of refs.pvcs) f.add(`pvc=${n}`);
  for (const c of containersOf(spec)) {
    if (c.image) f.add(`image=${c.image}`);
    // The env VARIABLE names, not their values: a value can be a credential, and the name is
    // what identifies the shared input anyway ("all eight read DATABASE_URL").
    for (const e of c.env ?? []) if (e.name) f.add(`env=${e.name}`);
  }
  // The controller, not the ReplicaSet hash — "same Deployment" is the useful statement.
  const owner = p.metadata?.ownerReferences?.[0];
  if (owner?.kind) f.add(`ownerKind=${owner.kind}`);
  return f;
}

const intersect = (sets: Set<string>[]): Set<string> => {
  if (sets.length === 0) return new Set();
  const [first, ...rest] = sets;
  return new Set([...first].filter((v) => rest.every((s) => s.has(v))));
};

const CAP = 40;

export interface CorrelateOptions {
  broken: Array<{ name: string; facts: Set<string>; reason?: string }>;
  healthy: Array<{ name: string; facts: Set<string> }>;
}

/** exported for the test — the whole judgement of the tool */
export function correlate(opts: CorrelateOptions) {
  const { broken, healthy } = opts;
  const shared = intersect(broken.map((b) => b.facts));

  // A fact held by ANY healthy pod cannot explain why the broken ones are broken.
  const healthyFacts = new Set<string>();
  for (const h of healthy) for (const v of h.facts) healthyFacts.add(v);
  const unique = [...shared].filter((v) => !healthyFacts.has(v)).sort();

  // Facts that vary INSIDE the broken set — the fields worth ruling out as the cause.
  const varying = new Set<string>();
  for (const b of broken) for (const v of b.facts) if (!shared.has(v)) varying.add(v.split("=")[0]);

  const reasons = new Map<string, number>();
  for (const b of broken) {
    const r = b.reason ?? "unknown";
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }

  return {
    broken: { count: broken.length, pods: broken.map((b) => b.name).slice(0, CAP) },
    healthyCompared: healthy.length,
    reasons: Object.fromEntries(reasons),
    // The answer. Read this first.
    uniqueToBroken: healthy.length === 0 ? [] : unique.slice(0, CAP),
    sharedWithHealthy: [...shared].filter((v) => healthyFacts.has(v)).sort().slice(0, CAP),
    varyingFields: [...varying].sort(),
    verdict:
      broken.length < 2
        ? "Fewer than two broken pods — there is nothing to correlate. Investigate this one directly."
        : healthy.length === 0
          ? `${broken.length} broken pods and NO healthy pod in this namespace to compare against, so nothing can be singled out — with no control group every shared attribute looks unique. Treat the shared list as context only, or widen the comparison.`
          : unique.length > 0
            ? `${broken.length} broken pods share ${unique.length} attribute(s) that NO healthy pod in this namespace has. That is where a single shared cause would live — confirm it with a tool call before naming it as the root cause.`
            : `${broken.length} broken pods share nothing that healthy pods do not also have. A single shared cause is unlikely — treat these as separate faults, or look outside the pod spec (node pressure, an upstream dependency, a recent deploy).`,
  };
}

const NS_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const Input = z.object({
  namespace: z.string().regex(NS_RE),
  // Omitted = every not-ready pod in the namespace. That is the call the model can make straight
  // after k8s_cluster_health, without first naming eight pods it would have to list correctly.
  pods: z.array(z.string().min(1)).optional(),
  label_selector: blankToUndefined(z.string().optional()),
});

export const correlatePods = (input: unknown) => {
  const { namespace, pods, label_selector } = Input.parse(input);
  return withUpstream("kubernetes", "Failed to correlate pods", async () => {
    const res = await getApi(k8s.CoreV1Api).listNamespacedPod({ namespace, labelSelector: label_selector });
    const all = res.items as PodLike[];

    const wanted = pods && pods.length > 0 ? new Set(pods) : null;
    const brokenPods = wanted
      ? all.filter((p) => wanted.has(p.metadata?.name ?? ""))
      : all.filter((p) => p.status?.phase !== "Succeeded" && !isReady(p));
    const healthyPods = all.filter((p) => !brokenPods.includes(p) && isReady(p));

    return correlate({
      broken: brokenPods.map((p) => ({ name: p.metadata?.name ?? "?", facts: factsOf(p), reason: reasonOf(p) })),
      healthy: healthyPods.map((p) => ({ name: p.metadata?.name ?? "?", facts: factsOf(p) })),
    });
  });
};
