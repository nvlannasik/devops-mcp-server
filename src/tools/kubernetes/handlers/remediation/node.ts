import { z } from "zod";
import { getApi, k8s, listAll } from "../../client.js";
import { parseCpu, parseMem } from "../../../capacity/rightsizing.js";
import { withUpstream, ValidationError } from "../../../../utils/errors/index.js";

// Node actions (spec 2026-11-04-node-ops-and-vm-agent-design, Part A). Cluster-scoped, so no
// namespace guardrail: a drain that skips namespaces is not a drain. What guards them instead:
// never the control plane, never the cluster's last schedulable node, and evictions only — the
// Eviction API honours PodDisruptionBudgets, so a protected pod comes back "blocked", not deleted.
//
// Two more for drain (2026-11-10, after the cluster moved from Longhorn to local-path):
// - A pod whose volume exists only on this node is NOT evicted. A local-path PV carries node
//   affinity to one hostname, so an evicted Postgres sits Pending until the node is uncordoned —
//   longer down than leaving it, where it only stops if the node itself goes down, and comes back
//   with its data. Its PDB does not help: a single-replica PDB allows one disruption.
// - A drain whose pods cannot fit elsewhere is refused. With three small workers, "not the last
//   schedulable node" says nothing about whether 26 pods fit on the other two.
// Both run before the cordon, so a refused drain changes nothing.

const NodeInput = z.object({ node: z.string().min(1), dry_run: z.boolean().optional() });

type Quantities = Record<string, string>;
type NodeLike = {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { unschedulable?: boolean; taints?: Array<{ effect?: string }> };
  status?: { allocatable?: Quantities };
};
type Container = { resources?: { requests?: Quantities } };
type PodLike = {
  metadata?: { namespace?: string; name?: string; annotations?: Record<string, string>; ownerReferences?: Array<{ kind?: string; controller?: boolean }> };
  spec?: {
    nodeName?: string;
    containers?: Container[];
    initContainers?: Container[];
    volumes?: Array<{ name?: string; persistentVolumeClaim?: { claimName?: string }; ephemeral?: unknown }>;
  };
  status?: { phase?: string };
};
type Requirement = { key?: string; operator?: string; values?: string[] };
type NodeSelectorTerm = { matchExpressions?: Requirement[]; matchFields?: Requirement[] };
type PVLike = {
  spec?: { claimRef?: { namespace?: string; name?: string }; nodeAffinity?: { required?: { nodeSelectorTerms?: NodeSelectorTerm[] } } };
};

const isControlPlane = (n: NodeLike): boolean => {
  const labels = n.metadata?.labels ?? {};
  return "node-role.kubernetes.io/control-plane" in labels || "node-role.kubernetes.io/master" in labels;
};
const isSchedulable = (n: NodeLike): boolean =>
  !n.spec?.unschedulable && !(n.spec?.taints ?? []).some((t) => t.effect === "NoSchedule" || t.effect === "NoExecute");

/** The refusals cordon and drain share: the node exists, is not the control plane, and is not the last place pods can go. */
async function assertCanTakeOut(api: k8s.CoreV1Api, node: string): Promise<{ target: NodeLike; others: NodeLike[] }> {
  const target = (await api.readNode({ name: node })) as NodeLike;
  if (isControlPlane(target)) throw new ValidationError(`node \`${node}\` is a control-plane node — taking it out of scheduling is not a remediation this agent makes`);
  const others = ((await api.listNode()) as { items: NodeLike[] }).items.filter((n) => n.metadata?.name !== node && isSchedulable(n));
  if (others.length === 0) throw new ValidationError(`node \`${node}\` is the last schedulable node in this cluster — cordoning it leaves nowhere for pods to go`);
  return { target, others };
}

const cordonBody = (unschedulable: boolean) => ({ spec: { unschedulable } });

export const cordonNode = (input: unknown) => {
  const { node, dry_run } = NodeInput.parse(input);
  return withUpstream("kubernetes", `Failed to cordon node \`${node}\``, async () => {
    const api = getApi(k8s.CoreV1Api);
    const { target } = await assertCanTakeOut(api, node);
    if (target.spec?.unschedulable) throw new ValidationError(`node \`${node}\` is already cordoned`);
    if (!dry_run) await api.patchNode({ name: node, body: cordonBody(true) });
    return {
      action: "cordon",
      node,
      dryRun: !!dry_run,
      result: dry_run ? `validated — \`${node}\` can be cordoned (nothing was changed)` : `node \`${node}\` cordoned — no new pods are scheduled there`,
    };
  });
};

export const uncordonNode = (input: unknown) => {
  const { node, dry_run } = NodeInput.parse(input);
  return withUpstream("kubernetes", `Failed to uncordon node \`${node}\``, async () => {
    const api = getApi(k8s.CoreV1Api);
    const target = (await api.readNode({ name: node })) as NodeLike;
    if (!target.spec?.unschedulable) throw new ValidationError(`node \`${node}\` is already schedulable — there is nothing to uncordon`);
    if (!dry_run) await api.patchNode({ name: node, body: cordonBody(false) });
    return {
      action: "uncordon",
      node,
      dryRun: !!dry_run,
      result: dry_run ? `validated — \`${node}\` can be uncordoned (nothing was changed)` : `node \`${node}\` uncordoned — it takes new pods again`,
    };
  });
};

const isFinished = (p: PodLike): boolean => p.status?.phase === "Succeeded" || p.status?.phase === "Failed";

/** A pod a drain leaves alone: its DaemonSet would put it straight back, it is a static (mirror) pod, or it has finished. */
const leftInPlace = (p: PodLike): boolean =>
  (p.metadata?.ownerReferences ?? []).some((o) => o.kind === "DaemonSet") ||
  "kubernetes.io/config.mirror" in (p.metadata?.annotations ?? {}) ||
  isFinished(p);

function requirementHolds(r: Requirement, value: string | undefined): boolean {
  const values = r.values ?? [];
  switch (r.operator) {
    case "In":
      return value !== undefined && values.includes(value);
    case "NotIn":
      return value === undefined || !values.includes(value);
    case "Exists":
      return value !== undefined;
    case "DoesNotExist":
      return value === undefined;
    case "Gt":
      return value !== undefined && Number(value) > Number(values[0]);
    case "Lt":
      return value !== undefined && Number(value) < Number(values[0]);
    default:
      return false;
  }
}

/**
 * Kubernetes' required node-selector semantics: terms are ORed, the requirements inside a term are
 * ANDed, and an empty term matches nothing. matchFields supports only `metadata.name`.
 */
export function nodeMatchesTerms(n: NodeLike, terms: NodeSelectorTerm[]): boolean {
  const labels = n.metadata?.labels ?? {};
  return terms.some((t) => {
    const exprs = t.matchExpressions ?? [];
    const fields = t.matchFields ?? [];
    if (exprs.length + fields.length === 0) return false;
    return (
      exprs.every((r) => requirementHolds(r, r.key === undefined ? undefined : labels[r.key])) &&
      fields.every((r) => requirementHolds(r, r.key === "metadata.name" ? n.metadata?.name : undefined))
    );
  });
}

/** The PVC names a pod mounts, including the one a generic ephemeral volume creates (`<pod>-<volume>`). */
const claimsOf = (p: PodLike): string[] =>
  (p.spec?.volumes ?? []).flatMap((v) =>
    v.persistentVolumeClaim?.claimName ? [v.persistentVolumeClaim.claimName] : v.ephemeral && v.name ? [`${p.metadata?.name}-${v.name}`] : []
  );

/** The claim that pins a pod here: its PV's node affinity is satisfied by none of the other schedulable nodes. */
function pinningClaim(p: PodLike, pvByClaim: Map<string, PVLike>, others: NodeLike[]): string | null {
  for (const claim of claimsOf(p)) {
    const terms = pvByClaim.get(`${p.metadata?.namespace}/${claim}`)?.spec?.nodeAffinity?.required?.nodeSelectorTerms;
    if (terms?.length && !others.some((n) => nodeMatchesTerms(n, terms))) return claim;
  }
  return null;
}

type Req = { cpu: number; mem: number };
const ZERO: Req = { cpu: 0, mem: 0 };
const add = (a: Req, b: Req): Req => ({ cpu: a.cpu + b.cpu, mem: a.mem + b.mem });

/** What the scheduler reserves for a pod: the containers' requests summed, or the largest init container's if that is bigger. */
function podRequests(p: PodLike): Req {
  const of = (c: Container): Req => ({ cpu: parseCpu(c.resources?.requests?.cpu) ?? 0, mem: parseMem(c.resources?.requests?.memory) ?? 0 });
  const main = (p.spec?.containers ?? []).map(of).reduce(add, ZERO);
  const init = (p.spec?.initContainers ?? []).map(of);
  return { cpu: Math.max(main.cpu, ...init.map((r) => r.cpu)), mem: Math.max(main.mem, ...init.map((r) => r.mem)) };
}

const fmtMem = (b: number): string => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)}Gi` : `${Math.round(b / 1024 ** 2)}Mi`);
const fmtCpu = (c: number): string => (c >= 1 ? `${c.toFixed(2)} cores` : `${Math.round(c * 1000)}m`);

export const drainNode = (input: unknown) => {
  const { node, dry_run } = NodeInput.parse(input);
  return withUpstream("kubernetes", `Failed to drain node \`${node}\``, async () => {
    const api = getApi(k8s.CoreV1Api);
    const { target, others } = await assertCanTakeOut(api, node);

    const [podList, pvs] = await Promise.all([
      listAll<PodLike>((o) => api.listPodForAllNamespaces(o) as never),
      api.listPersistentVolume() as Promise<{ items: PVLike[] }>,
    ]);
    // Free room is computed from every pod in the cluster; a partial listing would overstate it.
    if (!podList.complete) throw new ValidationError(`the cluster has more pods than one scan reads — cannot check where \`${node}\`'s pods would fit, so it is not drained`);
    const pvByClaim = new Map<string, PVLike>();
    for (const pv of pvs.items) {
      const ref = pv.spec?.claimRef;
      if (ref?.namespace && ref.name) pvByClaim.set(`${ref.namespace}/${ref.name}`, pv);
    }

    const keyOf = (p: PodLike) => `${p.metadata?.namespace ?? ""}/${p.metadata?.name ?? ""}`;
    const skipped: string[] = [];
    const pinned: Array<{ pod: string; claim: string }> = [];
    const toEvict: PodLike[] = [];
    for (const p of podList.items.filter((x) => x.spec?.nodeName === node)) {
      if (leftInPlace(p)) {
        skipped.push(keyOf(p));
        continue;
      }
      const claim = pinningClaim(p, pvByClaim, others);
      if (claim) pinned.push({ pod: keyOf(p), claim });
      else toEvict.push(p);
    }

    // Necessary, not sufficient: a sum over nodes, not a bin-packing — nodeSelectors, affinity and
    // per-node fragmentation can still leave a pod Pending when this passes. It catches the drain
    // that cannot possibly fit.
    const moving = toEvict.map(podRequests).reduce(add, ZERO);
    const free = others
      .map((n) => {
        const alloc = { cpu: parseCpu(n.status?.allocatable?.cpu), mem: parseMem(n.status?.allocatable?.memory) };
        // Unreadable is not zero: say so, rather than refuse with a "0Mi free" that reads as a full cluster.
        if (alloc.cpu === null || alloc.mem === null) {
          throw new ValidationError(`cannot read node \`${n.metadata?.name}\`'s allocatable resources — cannot check where \`${node}\`'s pods would fit, so it is not drained`);
        }
        const used = podList.items
          .filter((p) => p.spec?.nodeName === n.metadata?.name && !isFinished(p))
          .map(podRequests)
          .reduce(add, ZERO);
        return { cpu: Math.max(0, alloc.cpu - used.cpu), mem: Math.max(0, alloc.mem - used.mem) };
      })
      .reduce(add, ZERO);
    if (moving.mem > free.mem || moving.cpu > free.cpu) {
      throw new ValidationError(
        `draining \`${node}\` would move ${toEvict.length} pod(s) requesting ${fmtMem(moving.mem)} memory / ${fmtCpu(moving.cpu)} CPU, ` +
          `but the other schedulable nodes have only ${fmtMem(free.mem)} / ${fmtCpu(free.cpu)} free — they would sit Pending. Nothing was changed.`
      );
    }

    if (!dry_run && !target.spec?.unschedulable) await api.patchNode({ name: node, body: cordonBody(true) });
    const evicted: string[] = [];
    const blocked: string[] = [];
    for (const p of toEvict) {
      const namespace = p.metadata?.namespace ?? "";
      const name = p.metadata?.name ?? "";
      try {
        await api.createNamespacedPodEviction({
          name,
          namespace,
          body: { metadata: { name, namespace }, ...(dry_run ? { deleteOptions: { dryRun: ["All"] } } : {}) },
        });
        evicted.push(keyOf(p));
      } catch (err) {
        // 429 is the PodDisruptionBudget saying "not now" — the drain's answer, not its failure.
        if ((err as { code?: number }).code === 429) blocked.push(keyOf(p));
        else throw err;
      }
    }
    const verb = dry_run ? "would evict" : "evicted";
    return {
      action: "drain",
      node,
      dryRun: !!dry_run,
      evicted,
      blocked,
      pinned,
      skipped,
      capacity: { moving: { cpu: fmtCpu(moving.cpu), memory: fmtMem(moving.mem) }, free: { cpu: fmtCpu(free.cpu), memory: fmtMem(free.mem) } },
      result:
        `${dry_run ? "validated — " : `node \`${node}\` cordoned; `}${verb} ${evicted.length} pod(s)` +
        (blocked.length ? `, ${blocked.length} blocked by a PodDisruptionBudget (${blocked.join(", ")})` : "") +
        (pinned.length
          ? `, ${pinned.length} kept on the node because their volume exists only there (${pinned.map((x) => `${x.pod} via PVC ${x.claim}`).join(", ")}) — they stay up unless the node itself goes down`
          : "") +
        `, ${skipped.length} left in place (DaemonSet, static or finished)` +
        `; moved requests ${fmtMem(moving.mem)} / ${fmtCpu(moving.cpu)} onto ${fmtMem(free.mem)} / ${fmtCpu(free.cpu)} free elsewhere`,
    };
  });
};
