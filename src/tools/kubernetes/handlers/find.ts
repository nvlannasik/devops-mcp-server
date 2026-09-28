import { z } from "zod";
import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { blankToUndefined } from "../schemas.js";
import { provenanceOf, type ManagedBy } from "../provenance.js";
import config from "../../../config/index.js";

/**
 * Every object carrying one EXACT name, across the kinds people name things by — for the request
 * that names an object and not its kind.
 *
 * Measured on bench C10, 2026-09-26: "i think we can clean up bench-c10-cache in namespace
 * bench-c10" — the model assumed a Deployment, listed Deployments, and answered "No deployment
 * named `bench-c10-cache` found". It was a Service. A lookup by a guessed kind comes back empty,
 * and an empty lookup reads exactly like absence; nothing in that answer said the kind was the
 * guess. The prompt already carried a rule against concluding "not there" too early. It did not
 * hold, so the lookup that settles it is now one call.
 *
 * Exact names only, deliberately. `prompts/system.md` has a measured rule against substituting a
 * near-match — the agent once offered to delete an object with a similar name in a namespace
 * nobody had mentioned — and a tool that returned "similar" names would hand the model exactly
 * that candidate.
 *
 * A kind that could not be read is REPORTED, never dropped. RBAC can forbid one kind and not the
 * others, and "nothing found" among kinds that were not searched is not a finding — the same silent
 * gap an empty Loki result used to be.
 */

const LIST_TIMEOUT_SEC = Math.ceil(config.upstreamTimeoutMs / 1000);

// DNS-1123: every name a namespaced object can carry. Validated, not just typed, because the name
// is spliced into a fieldSelector — a comma there would add a second selector the caller never wrote.
const OBJECT_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

interface Meta {
  name?: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: Date | string;
  ownerReferences?: Array<{ kind?: string; name?: string; controller?: boolean }>;
}
type Lister = (namespace: string | undefined, fieldSelector: string) => Promise<{ items: Array<{ metadata?: Meta }> }>;

const opts = (fieldSelector: string) => ({ fieldSelector, timeoutSeconds: LIST_TIMEOUT_SEC });
const core = () => getApi(k8s.CoreV1Api);
const apps = () => getApi(k8s.AppsV1Api);
const batch = () => getApi(k8s.BatchV1Api);
const net = () => getApi(k8s.NetworkingV1Api);

// The kinds a person names in a sentence. ReplicaSets are left out on purpose: their names carry a
// template hash nobody types, and a workload match already leads to them.
const KINDS: Array<[kind: string, list: Lister]> = [
  ["Deployment", (ns, fs) => (ns ? apps().listNamespacedDeployment({ namespace: ns, ...opts(fs) }) : apps().listDeploymentForAllNamespaces(opts(fs)))],
  ["StatefulSet", (ns, fs) => (ns ? apps().listNamespacedStatefulSet({ namespace: ns, ...opts(fs) }) : apps().listStatefulSetForAllNamespaces(opts(fs)))],
  ["DaemonSet", (ns, fs) => (ns ? apps().listNamespacedDaemonSet({ namespace: ns, ...opts(fs) }) : apps().listDaemonSetForAllNamespaces(opts(fs)))],
  ["CronJob", (ns, fs) => (ns ? batch().listNamespacedCronJob({ namespace: ns, ...opts(fs) }) : batch().listCronJobForAllNamespaces(opts(fs)))],
  ["Job", (ns, fs) => (ns ? batch().listNamespacedJob({ namespace: ns, ...opts(fs) }) : batch().listJobForAllNamespaces(opts(fs)))],
  ["Pod", (ns, fs) => (ns ? core().listNamespacedPod({ namespace: ns, ...opts(fs) }) : core().listPodForAllNamespaces(opts(fs)))],
  ["Service", (ns, fs) => (ns ? core().listNamespacedService({ namespace: ns, ...opts(fs) }) : core().listServiceForAllNamespaces(opts(fs)))],
  ["Ingress", (ns, fs) => (ns ? net().listNamespacedIngress({ namespace: ns, ...opts(fs) }) : net().listIngressForAllNamespaces(opts(fs)))],
  ["ConfigMap", (ns, fs) => (ns ? core().listNamespacedConfigMap({ namespace: ns, ...opts(fs) }) : core().listConfigMapForAllNamespaces(opts(fs)))],
  // Name only: nothing below reads anything but metadata, so a Secret's data never reaches the result.
  ["Secret", (ns, fs) => (ns ? core().listNamespacedSecret({ namespace: ns, ...opts(fs) }) : core().listSecretForAllNamespaces(opts(fs)))],
  ["ServiceAccount", (ns, fs) => (ns ? core().listNamespacedServiceAccount({ namespace: ns, ...opts(fs) }) : core().listServiceAccountForAllNamespaces(opts(fs)))],
  ["PersistentVolumeClaim", (ns, fs) => (ns ? core().listNamespacedPersistentVolumeClaim({ namespace: ns, ...opts(fs) }) : core().listPersistentVolumeClaimForAllNamespaces(opts(fs)))],
];

export interface NameMatch {
  kind: string;
  namespace?: string;
  managedBy: ManagedBy;
  createdAt?: string;
  ownedBy?: string;
}

/** The per-kind outcome, before summarising: the items found, or why the kind could not be read. */
export interface KindResult {
  kind: string;
  items?: Array<{ metadata?: Meta }>;
  error?: string;
}

/** Pure: turns per-kind results into the answer. Exported for the test. */
export function summarizeByName(name: string, namespace: string | undefined, results: KindResult[], isNamespace = false) {
  const matches: NameMatch[] = results.flatMap((r) =>
    (r.items ?? []).map((i) => {
      const owner = i.metadata?.ownerReferences?.find((o) => o.controller);
      return {
        kind: r.kind,
        namespace: i.metadata?.namespace,
        ...provenanceOf(i.metadata),
        ...(owner?.kind && owner.name ? { ownedBy: `${owner.kind}/${owner.name}` } : {}),
      };
    })
  );
  const unreadable = results.filter((r) => r.error).map((r) => r.kind);
  const searched = results.filter((r) => !r.error).map((r) => r.kind);
  const scope = namespace ? `namespace \`${namespace}\`` : "any namespace";

  const kinds = [...new Set(matches.map((m) => m.kind))];
  let note: string;
  if (isNamespace) {
    // Measured 2026-09-28, bench C05: "how is bench-c05 doing?" sent the NAMESPACE name here, the
    // answer said nothing carried it, and the model filled the gap with invented object names.
    note =
      `\`${name}\` is a NAMESPACE. Ask about what is in it with namespace-scoped tools ` +
      `(k8s_cluster_health or k8s_list_pods with namespace \`${name}\`)` +
      (matches.length ? `; an object inside some namespace also carries the name — see matches.` : ", not with this lookup.");
  } else if (matches.length === 0) {
    note =
      `Nothing named \`${name}\` exists in ${scope} among the kinds searched. That IS evidence of absence for those ` +
      "kinds — but only for them: a custom resource can still carry the name (k8s_get_custom_resources).";
  } else if (kinds.length > 1) {
    note =
      `\`${name}\` is carried by more than one kind (${kinds.join(", ")}). Say which one you mean before acting on ` +
      "it — they are different objects that merely share a name.";
  } else {
    note = `\`${name}\` is a ${kinds[0]}${matches.length > 1 ? ` in ${matches.length} namespaces` : ""}. Use that kind with the tools for it.`;
  }
  // Said in the RESULT, not only in the prompt: the result is what the model reads right before it
  // picks its next call. Measured 2026-09-28, bench C10: with the rule only in prompts/system.md,
  // this lookup still stood in for the unused scan in 1 of 3 attempts, and a delete can only be
  // proposed for an object that scan lists under `orphanKeys` — the card was lost each time.
  if (matches.length > 0) {
    note +=
      " This lookup says what the name IS, not whether it is unused: to judge a cleanup, run " +
      "k8s_find_unused_resources — only an object it lists under orphanKeys can be offered for deletion.";
  }
  if (unreadable.length) {
    note += ` Could NOT read: ${unreadable.join(", ")} — absence there is unknown, not established.`;
  }
  return { name, scope: namespace ?? "all namespaces", ...(isNamespace ? { isNamespace: true } : {}), matches, searched, ...(unreadable.length ? { unreadable } : {}), note };
}

export const findByName = (input: unknown) => {
  const { name, namespace } = z
    .object({
      name: z
        .string()
        .max(253)
        .regex(OBJECT_NAME, "must be a Kubernetes object name: lowercase letters, digits, '-' and '.'"),
      // "" is a model meaning "anywhere" — see blankToUndefined
      namespace: blankToUndefined(z.string().min(1).optional()),
    })
    .parse(input);
  return withUpstream("kubernetes", `Failed to look up objects named ${name}`, async () => {
    const fieldSelector = `metadata.name=${name}`;
    const namespaceCheck = core().readNamespace({ name }).then(() => true, () => false);
    const results = await Promise.all(
      KINDS.map(async ([kind, list]): Promise<KindResult> => {
        try {
          return { kind, items: (await list(namespace, fieldSelector)).items };
        } catch (err) {
          return { kind, error: err instanceof Error ? err.message : String(err) };
        }
      })
    );
    return summarizeByName(name, namespace, results, await namespaceCheck);
  });
};
