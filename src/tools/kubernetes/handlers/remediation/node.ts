import { z } from "zod";
import { getApi, k8s } from "../../client.js";
import { withUpstream, ValidationError } from "../../../../utils/errors/index.js";

// Node actions (spec 2026-11-04-node-ops-and-vm-agent-design, Part A). Cluster-scoped, so no
// namespace guardrail: a drain that skips namespaces is not a drain. What guards them instead:
// never the control plane, never the cluster's last schedulable node, and evictions only — the
// Eviction API honours PodDisruptionBudgets, so a protected pod comes back "blocked", not deleted.

const NodeInput = z.object({ node: z.string().min(1), dry_run: z.boolean().optional() });

type NodeLike = { metadata?: { name?: string; labels?: Record<string, string> }; spec?: { unschedulable?: boolean; taints?: Array<{ effect?: string }> } };
type PodLike = {
  metadata?: { namespace?: string; name?: string; annotations?: Record<string, string>; ownerReferences?: Array<{ kind?: string; controller?: boolean }> };
  status?: { phase?: string };
};

const isControlPlane = (n: NodeLike): boolean => {
  const labels = n.metadata?.labels ?? {};
  return "node-role.kubernetes.io/control-plane" in labels || "node-role.kubernetes.io/master" in labels;
};
const isSchedulable = (n: NodeLike): boolean =>
  !n.spec?.unschedulable && !(n.spec?.taints ?? []).some((t) => t.effect === "NoSchedule" || t.effect === "NoExecute");

/** The refusals cordon and drain share: the node exists, is not the control plane, and is not the last place pods can go. */
async function assertCanTakeOut(api: k8s.CoreV1Api, node: string): Promise<NodeLike> {
  const target = (await api.readNode({ name: node })) as NodeLike;
  if (isControlPlane(target)) throw new ValidationError(`node \`${node}\` is a control-plane node — taking it out of scheduling is not a remediation this agent makes`);
  const others = ((await api.listNode()) as { items: NodeLike[] }).items.filter((n) => n.metadata?.name !== node && isSchedulable(n));
  if (others.length === 0) throw new ValidationError(`node \`${node}\` is the last schedulable node in this cluster — cordoning it leaves nowhere for pods to go`);
  return target;
}

const cordonBody = (unschedulable: boolean) => ({ spec: { unschedulable } });

export const cordonNode = (input: unknown) => {
  const { node, dry_run } = NodeInput.parse(input);
  return withUpstream("kubernetes", `Failed to cordon node \`${node}\``, async () => {
    const api = getApi(k8s.CoreV1Api);
    const target = await assertCanTakeOut(api, node);
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

/** A pod a drain leaves alone: its DaemonSet would put it straight back, it is a static (mirror) pod, or it has finished. */
const leftInPlace = (p: PodLike): boolean =>
  (p.metadata?.ownerReferences ?? []).some((o) => o.kind === "DaemonSet") ||
  "kubernetes.io/config.mirror" in (p.metadata?.annotations ?? {}) ||
  p.status?.phase === "Succeeded" ||
  p.status?.phase === "Failed";

export const drainNode = (input: unknown) => {
  const { node, dry_run } = NodeInput.parse(input);
  return withUpstream("kubernetes", `Failed to drain node \`${node}\``, async () => {
    const api = getApi(k8s.CoreV1Api);
    const target = await assertCanTakeOut(api, node);
    if (!dry_run && !target.spec?.unschedulable) await api.patchNode({ name: node, body: cordonBody(true) });
    const pods = ((await api.listPodForAllNamespaces({ fieldSelector: `spec.nodeName=${node}` })) as { items: PodLike[] }).items;
    const evicted: string[] = [];
    const blocked: string[] = [];
    const skipped: string[] = [];
    for (const p of pods) {
      const namespace = p.metadata?.namespace ?? "";
      const name = p.metadata?.name ?? "";
      const key = `${namespace}/${name}`;
      if (leftInPlace(p)) {
        skipped.push(key);
        continue;
      }
      try {
        await api.createNamespacedPodEviction({
          name,
          namespace,
          body: { metadata: { name, namespace }, ...(dry_run ? { deleteOptions: { dryRun: ["All"] } } : {}) },
        });
        evicted.push(key);
      } catch (err) {
        // 429 is the PodDisruptionBudget saying "not now" — the drain's answer, not its failure.
        if ((err as { code?: number }).code === 429) blocked.push(key);
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
      skipped,
      result:
        `${dry_run ? "validated — " : `node \`${node}\` cordoned; `}${verb} ${evicted.length} pod(s)` +
        (blocked.length ? `, ${blocked.length} blocked by a PodDisruptionBudget (${blocked.join(", ")})` : "") +
        `, ${skipped.length} left in place (DaemonSet, static or finished)`,
    };
  });
};
