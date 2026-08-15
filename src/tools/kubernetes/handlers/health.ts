import { z } from "zod";
import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import config from "../../../config/index.js";

// Cluster-wide pod health in ONE call. Every other list tool in this server is per-namespace,
// so "is anything broken?" cost one call per namespace — and against the agent's mention tool
// budget that means it answered from a partial, run-to-run different sample of the cluster
// while sounding certain ("all healthy" after looking at 6 of 20 namespaces). A wrong answer
// delivered confidently to an on-call is worse than no answer, so this tool trades a wide read
// for a narrow, complete one: scan everything, return only what is wrong.

const LIST_TIMEOUT_SEC = Math.ceil(config.upstreamTimeoutMs / 1000);

// Deliberately NOT config.k8sListLimit. That cap keeps a big namespace listing from being
// truncated into garbage downstream; here the response is already a summary, so capping the
// *scan* would reintroduce the exact silent-partial-answer bug this tool exists to kill.
// Instead: page through everything, and if the guard below ever trips, say so in the output.
const PAGE_LIMIT = 500;
const MAX_PODS_SCANNED = 10000;

// The response must stay small — the agent truncates tool results at 8000 chars, and a
// truncated health report is a lying health report. Counts are never capped, only the lists.
const UNHEALTHY_CAP = 50;
const RESTARTED_CAP = 20;

interface ContainerStatusLike {
  ready?: boolean;
  restartCount?: number;
  state?: { waiting?: { reason?: string }; terminated?: { reason?: string } };
  lastState?: { terminated?: { reason?: string; finishedAt?: Date | string } };
}

export interface PodLike {
  metadata?: {
    name?: string;
    namespace?: string;
    creationTimestamp?: Date | string;
    deletionTimestamp?: Date | string;
  };
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
    containerStatuses?: ContainerStatusLike[];
    initContainerStatuses?: ContainerStatusLike[];
  };
}

// Waiting reasons that only mean "not there yet". Still shown when nothing better exists — a
// pod stuck in ContainerCreating for 20 minutes is a volume that won't mount — but a real
// reason on any other container wins.
const TRANSIENT = new Set(["ContainerCreating", "PodInitializing"]);

// The single most useful field: CrashLoopBackOff / ImagePullBackOff / CreateContainerConfigError
// come from the waiting state, OOMKilled from the last termination.
function podReason(p: PodLike): string | undefined {
  const cs = [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])];
  const waiting = cs.map((c) => c.state?.waiting?.reason).filter((r): r is string => !!r);
  const specific = waiting.find((r) => !TRANSIENT.has(r));
  if (specific) return specific;
  for (const c of cs) {
    const t = c.state?.terminated?.reason ?? c.lastState?.terminated?.reason;
    if (t && t !== "Completed") return t;
  }
  return waiting[0];
}

const ms = (t: Date | string | undefined): number | null => {
  if (!t) return null;
  const n = new Date(t).getTime();
  return Number.isNaN(n) ? null : n;
};

// Most recent restart across all containers — what separates "crashed once last week" from
// "flapping right now" on a pod that currently reads ready.
function lastRestartAt(p: PodLike): number | null {
  const times = (p.status?.containerStatuses ?? [])
    .map((c) => ms(c.lastState?.terminated?.finishedAt))
    .filter((n): n is number => n !== null);
  return times.length ? Math.max(...times) : null;
}

const restartsOf = (p: PodLike): number =>
  (p.status?.containerStatuses ?? []).reduce((sum, c) => sum + (c.restartCount ?? 0), 0);

// A CrashLoopBackOff pod's phase is "Running" with ready:false — phase alone never finds it.
// Readiness comes from containerStatuses, same convention as k8s_list_pods (missing statuses
// read as not-ready: a pod that isn't reporting readiness belongs in the report, not hidden).
function isReady(p: PodLike): boolean {
  const cs = p.status?.containerStatuses;
  return (cs?.length ?? 0) > 0 && cs!.every((c) => c.ready);
}

// Failed first, then crashlooping, then stuck scheduling. Terminating pods sink: during a
// rolling update the old replicas are legitimately not-ready and would otherwise crowd out
// the real fault.
function severity(phase: string | undefined, terminating: boolean): number {
  if (terminating) return 0;
  if (phase === "Failed") return 3;
  if (phase === "Running" || phase === "Unknown") return 2;
  return 1; // Pending
}

export interface ClusterHealthOptions {
  complete: boolean;
  restartWindowMinutes: number;
  now: number;
}

// exported for unit tests
export function shapeClusterHealth(pods: PodLike[], opts: ClusterHealthOptions) {
  const { complete, restartWindowMinutes, now } = opts;
  const windowMs = restartWindowMinutes * 60 * 1000;
  const namespaces = new Set<string>();
  const summary = { running: 0, pending: 0, succeeded: 0, failed: 0, unknown: 0, notReady: 0 };

  const unhealthy: Array<Record<string, unknown>> = [];
  const restarted: Array<Record<string, unknown>> = [];

  for (const p of pods) {
    const ns = p.metadata?.namespace;
    if (ns) namespaces.add(ns);
    const phase = p.status?.phase;
    switch (phase) {
      case "Running": summary.running++; break;
      case "Pending": summary.pending++; break;
      case "Succeeded": summary.succeeded++; break;
      case "Failed": summary.failed++; break;
      default: summary.unknown++;
    }

    // A completed Job pod is not a fault. Everything else is judged on readiness, not phase.
    if (phase === "Succeeded") continue;

    const ready = isReady(p);
    const terminating = !!p.metadata?.deletionTimestamp;
    if (!ready) summary.notReady++;

    const base = {
      namespace: ns,
      name: p.metadata?.name,
      status: phase,
      ready,
      restarts: restartsOf(p),
      reason: podReason(p),
      node: p.spec?.nodeName,
      age: p.metadata?.creationTimestamp,
    };

    if (phase === "Failed" || phase === "Pending" || phase === "Unknown" || !ready) {
      unhealthy.push(terminating ? { ...base, terminating: true } : base);
      continue;
    }

    // Ready now, but it went down recently — the "it already recovered" case an on-call
    // still wants to hear about.
    const last = lastRestartAt(p);
    if (last !== null && now - last <= windowMs) {
      restarted.push({ ...base, lastRestart: new Date(last).toISOString() });
    }
  }

  unhealthy.sort(
    (a, b) =>
      severity(b.status as string | undefined, !!b.terminating) -
      severity(a.status as string | undefined, !!a.terminating)
  );
  restarted.sort((a, b) => String(b.lastRestart).localeCompare(String(a.lastRestart)));

  return {
    scanned: { pods: pods.length, namespaces: namespaces.size, complete },
    summary,
    unhealthyTotal: unhealthy.length,
    unhealthy: unhealthy.slice(0, UNHEALTHY_CAP),
    recentlyRestartedTotal: restarted.length,
    recentlyRestarted: restarted.slice(0, RESTARTED_CAP),
    restartWindowMinutes,
  };
}

// `namespace` is optional AND has no default — unlike every other tool here, where omitting it
// means the "default" namespace. Omitting it here means the whole cluster, which is the point.
// No .int() — a model that answers "90.0" or "1.5" would otherwise get a raw ZodError back
// from the tool it reaches for FIRST on every mention, and loop. The value only feeds a
// multiplication, so rounding a float costs nothing and removes that failure entirely.
const ClusterHealthInput = z.object({
  namespace: z.string().min(1).optional(),
  restart_window_minutes: z.number().positive().default(60),
});

export const clusterHealth = (input: unknown) => {
  const { namespace, restart_window_minutes } = ClusterHealthInput.parse(input);
  return withUpstream("kubernetes", "Failed to read cluster health", async () => {
    const api = getApi(k8s.CoreV1Api);
    const pods: PodLike[] = [];
    let cont: string | undefined;
    let complete = true;

    do {
      const page = namespace
        ? await api.listNamespacedPod({ namespace, limit: PAGE_LIMIT, _continue: cont, timeoutSeconds: LIST_TIMEOUT_SEC })
        : await api.listPodForAllNamespaces({ limit: PAGE_LIMIT, _continue: cont, timeoutSeconds: LIST_TIMEOUT_SEC });
      pods.push(...(page.items as PodLike[]));
      cont = page.metadata?._continue || undefined;
      if (cont && pods.length >= MAX_PODS_SCANNED) {
        complete = false;
        break;
      }
    } while (cont);

    return shapeClusterHealth(pods, {
      complete,
      restartWindowMinutes: Math.max(1, Math.round(restart_window_minutes)),
      now: Date.now(),
    });
  });
};
