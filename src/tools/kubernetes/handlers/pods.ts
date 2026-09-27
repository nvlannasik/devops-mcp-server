import { z } from "zod";
import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NS, NSLabel, blankToUndefined } from "../schemas.js";
import config from "../../../config/index.js";

const LIST_TIMEOUT_SEC = Math.ceil(config.upstreamTimeoutMs / 1000);

export const listPods = (input: unknown) => {
  const { namespace, label_selector } = NSLabel.parse(input);
  return withUpstream("kubernetes", "Failed to list pods", async () => {
    const res = await getApi(k8s.CoreV1Api).listNamespacedPod({
      namespace,
      labelSelector: label_selector,
      limit: config.k8sListLimit,
      timeoutSeconds: LIST_TIMEOUT_SEC,
    });
    return res.items.map((pod) => ({
      name: pod.metadata!.name,
      namespace: pod.metadata!.namespace,
      status: pod.status!.phase,
      ready: pod.status!.containerStatuses?.every((c) => c.ready) ?? false,
      restarts: pod.status!.containerStatuses?.reduce((sum, c) => sum + c.restartCount, 0) ?? 0,
      node: pod.spec!.nodeName,
      age: pod.metadata!.creationTimestamp,
    }));
  });
};

interface PodForPick {
  metadata?: { annotations?: Record<string, string> };
  spec?: { containers?: Array<{ name: string }>; initContainers?: Array<{ name: string }> };
  status?: { containerStatuses?: Array<{ name: string; ready: boolean; restartCount: number }> };
}

/**
 * Which container's logs to read when the caller did not say — for a pod with more than one.
 *
 * Kubernetes refuses the call outright ("a container name must be specified for pod loki-0, choose
 * one of: [loki loki-sc-rules]") and so did this tool, verbatim. The model does get the names, but
 * it spends a tool round learning them, and a Slack mention has TWO rounds in total
 * (MENTION_TOOL_ROUNDS): half the budget gone before one log line is read. 11 of 59 pods in this
 * cluster have more than one container, so this is the ordinary case, not an edge.
 *
 * The pick is the container most likely to be the one asked about: the one that restarted (for
 * `previous: true`, the crash is in a restarted container by definition), else one that is not
 * ready — with sidecars, the main container is often healthy while the proxy or shipper beside it
 * is what fails readiness — else the pod's own `kubectl.kubernetes.io/default-container`
 * annotation, which kubectl honours and the API does not, else the first container. The answer
 * always names what was read, why, and what else exists, so a wrong guess costs a sentence to
 * notice rather than a wrong conclusion. Exported for the test.
 */
export function pickContainer(
  pod: PodForPick,
  previous: boolean
): { container: string; because: string; otherContainers: string[]; initContainers?: string[] } | null {
  const names = (pod.spec?.containers ?? []).map((c) => c.name);
  if (names.length < 2) return null;
  const status = new Map((pod.status?.containerStatuses ?? []).map((s) => [s.name, s]));
  const restarts = (n: string) => status.get(n)?.restartCount ?? 0;
  const byRestarts = [...names].sort((a, b) => restarts(b) - restarts(a));
  const restarted = byRestarts.find((n) => restarts(n) > 0);
  const notReady = byRestarts.find((n) => status.has(n) && !status.get(n)!.ready);
  const annotated = pod.metadata?.annotations?.["kubectl.kubernetes.io/default-container"];

  let container: string;
  let because: string;
  if (previous && restarted) [container, because] = [restarted, `it restarted ${restarts(restarted)} time(s) — the previous instance is the crashed one`];
  else if (notReady) [container, because] = [notReady, `it is not ready${restarts(notReady) ? ` (${restarts(notReady)} restart(s))` : ""}`];
  else if (restarted) [container, because] = [restarted, `it restarted ${restarts(restarted)} time(s)`];
  else if (annotated && names.includes(annotated)) [container, because] = [annotated, "the pod's kubectl.kubernetes.io/default-container annotation names it — nothing is failing"];
  else [container, because] = [names[0], "it is the first container — nothing is failing"];

  const init = (pod.spec?.initContainers ?? []).map((c) => c.name);
  return { container, because, otherContainers: names.filter((n) => n !== container), ...(init.length ? { initContainers: init } : {}) };
}

// The exact refusal Kubernetes gives for an unnamed container on a multi-container pod. Matched
// against every string the client exposes on the error, since where the body lands differs by
// client version.
const MUST_NAME_CONTAINER = /a container name must be specified/i;
const errorText = (err: unknown): string =>
  [String(err), (err as { body?: unknown })?.body].map((x) => (typeof x === "string" ? x : JSON.stringify(x ?? ""))).join(" ");

export const getPodLogs = (input: unknown) => {
  const { pod_name, namespace, container, tail_lines, previous, since_seconds } = NS.extend({
    pod_name: z.string().min(1),
    // "" is a model saying "whichever" — same rule as remediation's container; see blankToUndefined
    container: blankToUndefined(z.string().min(1).optional()),
    tail_lines: z.number().int().positive().default(100),
    previous: z.boolean().default(false), // logs from the crashed/prior container instance — the CrashLoop root cause
    since_seconds: z.number().int().positive().optional(),
  }).parse(input);
  return withUpstream("kubernetes", `Failed to get logs for pod ${pod_name}`, async () => {
    const api = getApi(k8s.CoreV1Api);
    const read = (c: string | undefined) =>
      api.readNamespacedPodLog({ name: pod_name, namespace, container: c, tailLines: tail_lines, previous, sinceSeconds: since_seconds });
    if (container) return { logs: await read(container) };
    // Try the plain call first: a single-container pod — most of them — pays nothing for this.
    try {
      return { logs: await read(undefined) };
    } catch (err) {
      if (!MUST_NAME_CONTAINER.test(errorText(err))) throw err;
      const pick = pickContainer(await api.readNamespacedPod({ name: pod_name, namespace }), previous);
      if (!pick) throw err;
      return {
        container: pick.container,
        pickedBecause: pick.because,
        otherContainers: pick.otherContainers,
        ...(pick.initContainers ? { initContainers: pick.initContainers } : {}),
        logs: await read(pick.container),
      };
    }
  });
};
