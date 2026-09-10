import { findUnusedResources } from "./unused.js";
import { recommendResources } from "./rightsizing.js";
import type { Tool } from "../types.js";

// Named `k8s_*` although the module is `capacity/`: the model reaches for these next to the
// other cluster tools, and one of them joins Prometheus so it belongs in neither domain folder.
const tools: Tool[] = [
  {
    name: "k8s_find_unused_resources",
    description:
      "Orphaned/idle Kubernetes objects across the cluster in ONE call (the `kor` question): PVCs nothing mounts, " +
      "Services with zero endpoint addresses, Deployments/StatefulSets scaled to 0, DaemonSets that match no node, " +
      "and ConfigMaps/Secrets/ServiceAccounts nothing references. " +
      "USE THIS for 'what can we clean up', 'unused resources', 'orphaned', 'idle', 'wasted', 'cost'. " +
      "References are read from running pods AND every workload pod template, so a scaled-to-zero Deployment does " +
      "NOT make its config look unused. " +
      "It is a REVIEW list, not a delete list — an object read through the API by an operator or CRD looks unused " +
      "here and is not. Never propose deleting one without naming its owner. " +
      "For sizing (requests/limits vs real usage) use k8s_recommend_resources instead — this tool reads no metrics.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Optional — omit to scan the whole cluster" },
        include_system_namespaces: {
          type: "boolean",
          description: "Include kube-* namespaces (default: false — they are full of managed objects that only look unused)",
        },
      },
    },
    handler: findUnusedResources,
  },
  {
    name: "k8s_recommend_resources",
    description:
      "Right-sizing: compares each container's CONFIGURED requests/limits against its REAL usage from Prometheus " +
      "and returns per-container recommendations plus the cluster's over-reserved CPU/memory. " +
      "USE THIS for 'resource limits', 'requests', 'right-size', 'over-provisioned', 'how much does X actually use', " +
      "and as the Short-term action in any OOMKilled / CPU-throttling / Pending-pod RCA — it produces the concrete " +
      "number to change, so the recommendation is `512Mi -> 900Mi`, not 'consider raising the limit'. " +
      "Flags: `oom_risk`, `cpu_throttled`, `cpu_under_provisioned`, `memory_under_provisioned`, `no_requests`, " +
      "`over_provisioned`, `no_data`. " +
      "Read `method` before quoting a number — it is a percentile heuristic over `window`, not a VPA verdict. " +
      "Do NOT use it to find orphaned objects; that is k8s_find_unused_resources.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Optional — omit for every non-kube-* namespace" },
        workload: { type: "string", description: "Optional Deployment/StatefulSet/DaemonSet name to narrow to" },
        window: { type: "string", description: "Lookback for the usage stats, e.g. 6h, 24h, 7d (default: 24h)" },
      },
    },
    handler: recommendResources,
  },
];

export default tools;
