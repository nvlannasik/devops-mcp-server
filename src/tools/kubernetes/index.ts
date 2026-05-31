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
    description: "Get logs from a pod container",
    inputSchema: {
      type: "object",
      required: ["pod_name"],
      properties: {
        pod_name: { type: "string", description: "Pod name" },
        namespace: { type: "string", description: "Namespace (default: default)" },
        container: { type: "string", description: "Container name (optional)" },
        tail_lines: { type: "number", description: "Number of lines from end (default: 100)" },
      },
    },
    handler: h.getPodLogs,
  },
  {
    name: "k8s_list_deployments",
    description: "List deployments in a namespace",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Namespace (default: default)" } },
    },
    handler: h.listDeployments,
  },
  {
    name: "k8s_list_statefulsets",
    description: "List StatefulSets in a namespace",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Namespace (default: default)" } },
    },
    handler: h.listStatefulSets,
  },
  {
    name: "k8s_list_daemonsets",
    description: "List DaemonSets in a namespace",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string", description: "Namespace (default: default)" } },
    },
    handler: h.listDaemonSets,
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
    description: "List all CustomResourceDefinitions in the cluster",
    inputSchema: { type: "object", properties: {} },
    handler: h.listCRDs,
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
