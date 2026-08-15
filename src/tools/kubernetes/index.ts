import * as h from "./handlers/index.js";
import type { Tool } from "../types.js";

const tools: Tool[] = [
  {
    name: "k8s_list_namespaces",
    description: "List all namespaces in the Kubernetes cluster",
    inputSchema: { type: "object", properties: {} },
    handler: h.listNamespaces,
  },
  {
    name: "k8s_list_nodes",
    description: "List all nodes with status, roles, and resource capacity",
    inputSchema: { type: "object", properties: {} },
    handler: h.listNodes,
  },
  {
    name: "k8s_list_pods",
    description: "List pods in a namespace",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace (default: default)" },
        label_selector: { type: "string", description: "Label selector (e.g. app=nginx)" },
      },
    },
    handler: h.listPods,
  },
  {
    name: "k8s_get_pod_logs",
    description:
      "Get logs from a pod container. Set `previous: true` to read the CRASHED/prior container instance " +
      "(the current logs are the fresh restart — CrashLoop root cause is in the previous one). `since_seconds` " +
      "limits to a recent window.",
    inputSchema: {
      type: "object",
      required: ["pod_name"],
      properties: {
        pod_name: { type: "string", description: "Pod name" },
        namespace: { type: "string", description: "Namespace (default: default)" },
        container: { type: "string", description: "Container name (optional)" },
        tail_lines: { type: "number", description: "Number of lines from end (default: 100)" },
        previous: { type: "boolean", description: "Logs from the previous (crashed) container instance (default: false)" },
        since_seconds: { type: "number", description: "Only logs from the last N seconds (optional)" },
      },
    },
    handler: h.getPodLogs,
  },
  {
    name: "k8s_describe_pod",
    description:
      "Detailed status of ONE pod (the 'describe' view): per-container state incl. the exact " +
      "termination/waiting reason (OOMKilled, exit code, CrashLoopBackOff, ImagePullBackOff), " +
      "restart counts, pod conditions, QoS, configured requests/limits, node. Use this for " +
      "crash/OOM/not-Ready RCA — it gives the ground-truth reason logs only hint at. (No CPU/mem " +
      "usage — that's Prometheus.)",
    inputSchema: {
      type: "object",
      required: ["pod_name"],
      properties: {
        pod_name: { type: "string", description: "Pod name" },
        namespace: { type: "string", description: "Namespace (default: default)" },
      },
    },
    handler: h.describePod,
  },
  {
    name: "k8s_describe_node",
    description:
      "Detailed status of ONE node: conditions (Ready, MemoryPressure, DiskPressure, PIDPressure), " +
      "taints, unschedulable flag, capacity vs allocatable, kubelet/OS version. Use for Pending " +
      "pods / node-level incidents. (No live usage — that's Prometheus.)",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", description: "Node name" } },
    },
    handler: h.describeNode,
  },
  {
    name: "k8s_get_endpoints",
    description:
      "Ready vs not-ready backend addresses (pods) behind a Service — answers 'does this Service " +
      "have any ready endpoints?'. readyCount=0 explains 503 / connection-refused when the Service " +
      "exists but has no healthy pods. Pass the Service name.",
    inputSchema: {
      type: "object",
      required: ["service"],
      properties: {
        service: { type: "string", description: "Service name" },
        namespace: { type: "string", description: "Namespace (default: default)" },
      },
    },
    handler: h.getEndpoints,
  },
  {
    name: "k8s_list_deployments",
    description: "List deployments in a namespace, including each container's name and image (use this to answer image/tag questions)",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Namespace (default: default)" } },
    },
    handler: h.listDeployments,
  },
  {
    name: "k8s_list_statefulsets",
    description: "List StatefulSets in a namespace, including each container's name and image",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Namespace (default: default)" } },
    },
    handler: h.listStatefulSets,
  },
  {
    name: "k8s_list_daemonsets",
    description: "List DaemonSets in a namespace, including each container's name and image",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Namespace (default: default)" } },
    },
    handler: h.listDaemonSets,
  },
  {
    name: "k8s_get_rollout_status",
    description:
      "Rollout progress of ONE Deployment/StatefulSet/DaemonSet: desired vs updated/ready/available/unavailable replicas, `complete` flag, and conditions (e.g. Progressing=False ProgressDeadlineExceeded). Use for 'deploy stuck / not rolling out'.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Workload name" },
        namespace: { type: "string", description: "Namespace (default: default)" },
        kind: { type: "string", enum: ["deployment", "statefulset", "daemonset"], description: "Workload kind (default: deployment)" },
      },
    },
    handler: h.getRolloutStatus,
  },
  {
    name: "k8s_list_replicasets",
    description: "List ReplicaSets in a namespace with owner Deployment + revision + desired/ready — rollout history (which RS is active vs stale, failed old RS)",
    inputSchema: { type: "object", properties: { namespace: { type: "string", description: "Namespace (default: default)" } } },
    handler: h.listReplicaSets,
  },
  {
    name: "k8s_list_pvs",
    description: "List PersistentVolumes (cluster-scoped): phase (Bound/Available/Released/Failed), capacity, storageClass, reclaimPolicy, bound claim — for storage incidents",
    inputSchema: { type: "object", properties: {} },
    handler: h.listPersistentVolumes,
  },
  {
    name: "k8s_list_storageclasses",
    description: "List StorageClasses: provisioner, default flag, reclaim/binding mode — a PVC stuck Pending often means no default class or a broken provisioner",
    inputSchema: { type: "object", properties: {} },
    handler: h.listStorageClasses,
  },
  {
    name: "k8s_list_network_policies",
    description: "List NetworkPolicies in a namespace: podSelector, policyTypes, rule counts — for 'traffic blocked' investigations (a deny-all policy or missing allow rule)",
    inputSchema: { type: "object", properties: { namespace: { type: "string", description: "Namespace (default: default)" } } },
    handler: h.listNetworkPolicies,
  },
  {
    name: "k8s_list_pdbs",
    description: "List PodDisruptionBudgets in a namespace: min/maxUnavailable + disruptionsAllowed — disruptionsAllowed=0 blocks node drain/eviction and can stall rollouts",
    inputSchema: { type: "object", properties: { namespace: { type: "string", description: "Namespace (default: default)" } } },
    handler: h.listPDBs,
  },
  {
    name: "k8s_get_sa_permissions",
    description:
      "What a ServiceAccount is allowed to do: its Role/ClusterRole bindings and the resolved rules (apiGroups/resources/verbs). Use for `forbidden` / permission-denied RCA — shows whether the SA is missing a needed permission.",
    inputSchema: {
      type: "object",
      required: ["serviceaccount"],
      properties: {
        serviceaccount: { type: "string", description: "ServiceAccount name" },
        namespace: { type: "string", description: "Namespace (default: default)" },
      },
    },
    handler: h.getSaPermissions,
  },
  {
    name: "k8s_list_jobs",
    description: "List Jobs in a namespace",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Namespace (default: default)" } },
    },
    handler: h.listJobs,
  },
  {
    name: "k8s_list_cronjobs",
    description: "List CronJobs in a namespace",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Namespace (default: default)" } },
    },
    handler: h.listCronJobs,
  },
  {
    name: "k8s_list_services",
    description: "List Services in a namespace",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Namespace (default: default)" } },
    },
    handler: h.listServices,
  },
  {
    name: "k8s_list_ingresses",
    description: "List Ingresses in a namespace",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Namespace (default: default)" } },
    },
    handler: h.listIngresses,
  },
  {
    name: "k8s_list_hpas",
    description: "List HorizontalPodAutoscalers in a namespace",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Namespace (default: default)" } },
    },
    handler: h.listHPAs,
  },
  {
    name: "k8s_list_pvcs",
    description: "List PersistentVolumeClaims in a namespace",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Namespace (default: default)" } },
    },
    handler: h.listPVCs,
  },
  {
    name: "k8s_list_resource_quotas",
    description: "List ResourceQuotas in a namespace",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Namespace (default: default)" } },
    },
    handler: h.listResourceQuotas,
  },
  {
    name: "k8s_list_events",
    description: "List events in a namespace, optionally filtered by time",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace (default: default)" },
        field_selector: { type: "string", description: "Field selector (e.g. involvedObject.name=my-pod)" },
        since_minutes: { type: "number", description: "Only return events from the last N minutes (optional)" },
      },
    },
    handler: h.listEvents,
  },
  {
    name: "k8s_list_crds",
    description: "List all CustomResourceDefinitions in the cluster (the types — use k8s_get_custom_resources for the objects)",
    inputSchema: { type: "object", properties: {} },
    handler: h.listCRDs,
  },
  {
    name: "k8s_get_custom_resources",
    description:
      "Read custom resource OBJECTS of any CRD — e.g. Flux HelmRelease/Kustomization, cert-manager Certificate. " +
      "Without `name`: compact list (name + Ready condition + message). With `name`: the full object (spec + status). " +
      "Find group/version/plural via k8s_list_crds if unsure.",
    inputSchema: {
      type: "object",
      required: ["group", "version", "plural"],
      properties: {
        group: { type: "string", description: 'API group, e.g. "helm.toolkit.fluxcd.io"' },
        version: { type: "string", description: 'API version, e.g. "v2"' },
        plural: { type: "string", description: 'Resource plural, e.g. "helmreleases"' },
        namespace: { type: "string", description: "Namespace — omit for cluster-scoped resources" },
        name: { type: "string", description: "Object name — omit to list" },
      },
    },
    handler: h.getCustomResources,
  },
  {
    name: "k8s_get_resource",
    description:
      "Get ANY Kubernetes resource by apiVersion + kind — the full object (spec + status) when `name` is given, " +
      "or a compact list when it's omitted. Works for built-ins (apiVersion `v1`, `apps/v1`, `batch/v1`, " +
      "`networking.k8s.io/v1`, …) AND custom resources. Use when there's no dedicated tool for the kind, or you " +
      "need the raw object. Discover which apiVersions this cluster serves via k8s_list_api_resources.",
    inputSchema: {
      type: "object",
      required: ["api_version", "kind"],
      properties: {
        api_version: { type: "string", description: 'apiVersion: "v1" for core, else "<group>/<version>" e.g. "apps/v1"' },
        kind: { type: "string", description: 'Kind, e.g. "Deployment", "Ingress", "Job"' },
        name: { type: "string", description: "Object name — omit to list" },
        namespace: { type: "string", description: "Namespace — omit for cluster-scoped" },
      },
    },
    handler: h.getResource,
  },
  {
    name: "k8s_list_api_resources",
    description:
      "Discover which API groups/versions this cluster serves (like `kubectl api-resources`/`api-versions`): core " +
      "v1 kinds + every group with its versions. Use to find the right apiVersion for k8s_get_resource. For CRD " +
      "types and their plurals use k8s_list_crds.",
    inputSchema: { type: "object", properties: {} },
    handler: h.listApiResources,
  },
  {
    name: "k8s_list_service_accounts",
    description: "List ServiceAccounts in a namespace",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Namespace (default: default)" } },
    },
    handler: h.listServiceAccounts,
  },
  {
    name: "k8s_list_configmaps",
    description: "List ConfigMaps in a namespace with their keys and data",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Namespace (default: default)" } },
    },
    handler: h.listConfigMaps,
  },
  {
    name: "k8s_list_secrets",
    description: "List Secrets in a namespace (name and type only, values are not exposed)",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Namespace (default: default)" } },
    },
    handler: h.listSecrets,
  },
];

export default tools;
