import { rolloutRestart, setImage, setResources, scale, deletePod, fluxReconcile } from "./handlers/remediation.js";
import type { Tool } from "../types.js";

// [WRITE] tools — registered ONLY when MCP_ENABLE_WRITE_TOOLS=true (see src/tools/index.ts).
// Conditional REGISTRATION, not a runtime guard: the agent caches listTools() at startup,
// and a tool that is listed but refuses at call time makes the LLM loop on it.
// CONVENTION: every write tool's description MUST start with "[WRITE]" — the agent filters
// them out of its agentic loop by that prefix; they are only callable via the approval flow.

const KIND = { type: "string", enum: ["deployment", "statefulset", "daemonset"], description: "Workload kind" };
const NS = { type: "string", description: "Namespace of the workload" };
const NAME = { type: "string", description: "Workload name" };
const DRY = { type: "boolean", description: "Server-side dry run: validate only, change nothing" };
const CONTAINER = {
  type: "string",
  description: "Container name within the pod template. Optional — omit for single-container workloads (auto-resolved)",
};

const writeTools: Tool[] = [
  {
    name: "k8s_rollout_restart",
    description:
      "[WRITE] Rolling-restart a Deployment/StatefulSet/DaemonSet (kubectl rollout restart equivalent). " +
      "Only works in namespaces listed in ALLOWED_REMEDIATION_NAMESPACES. " +
      "Call with dry_run=true first to validate the target without changing anything.",
    inputSchema: {
      type: "object",
      required: ["namespace", "name"],
      properties: { namespace: NS, name: NAME, kind: KIND, dry_run: DRY },
    },
    handler: rolloutRestart,
  },
  {
    name: "k8s_set_image",
    description:
      "[WRITE] Change one container's image on a Deployment/StatefulSet/DaemonSet " +
      "(e.g. fix a nonexistent/broken image tag). Only in ALLOWED_REMEDIATION_NAMESPACES. " +
      "dry_run=true validates and reports current → new image without changing anything.",
    inputSchema: {
      type: "object",
      required: ["namespace", "name", "kind", "image"],
      properties: {
        namespace: NS,
        name: NAME,
        kind: KIND,
        container: CONTAINER,
        image: { type: "string", description: "Full new image reference (registry/repo:tag)" },
        dry_run: DRY,
      },
    },
    handler: setImage,
  },
  {
    name: "k8s_set_resources",
    description:
      "[WRITE] Update one container's resource requests/limits on a Deployment/StatefulSet/DaemonSet " +
      "(e.g. raise the memory limit after OOMKilled). Only provided values are changed. " +
      "Only in ALLOWED_REMEDIATION_NAMESPACES. dry_run=true validates without changing anything.",
    inputSchema: {
      type: "object",
      required: ["namespace", "name", "kind"],
      properties: {
        namespace: NS,
        name: NAME,
        kind: KIND,
        container: CONTAINER,
        cpu_request: { type: "string", description: 'K8s quantity, e.g. "250m"' },
        memory_request: { type: "string", description: 'K8s quantity, e.g. "256Mi"' },
        cpu_limit: { type: "string", description: 'K8s quantity, e.g. "1"' },
        memory_limit: { type: "string", description: 'K8s quantity, e.g. "1Gi"' },
        dry_run: DRY,
      },
    },
    handler: setResources,
  },
  {
    name: "k8s_scale",
    description:
      "[WRITE] Change the replica count of a Deployment/StatefulSet (DaemonSets have no replicas). " +
      "Bounded by MAX_SCALE_DELTA; scaling to zero is always refused. " +
      "Only in ALLOWED_REMEDIATION_NAMESPACES. dry_run=true validates without changing anything.",
    inputSchema: {
      type: "object",
      required: ["namespace", "name", "kind", "replicas"],
      properties: {
        namespace: NS,
        name: NAME,
        kind: { type: "string", enum: ["deployment", "statefulset"], description: "Workload kind (no daemonset)" },
        replicas: { type: "number", description: "Target replica count (>= 1)" },
        dry_run: DRY,
      },
    },
    handler: scale,
  },
  {
    name: "k8s_delete_pod",
    description:
      "[WRITE] Delete ONE stuck/wedged pod so its controller recreates it fresh (same spec). " +
      "Refused for pods without a recreating controller (ReplicaSet/StatefulSet/DaemonSet) — no replacement = outage. " +
      "GitOps-safe (like rollout_restart). Only in ALLOWED_REMEDIATION_NAMESPACES. " +
      "dry_run=true validates the target and reports the owning controller without changing anything.",
    inputSchema: {
      type: "object",
      required: ["namespace", "pod"],
      properties: {
        namespace: NS,
        pod: { type: "string", description: "Exact pod name (not the workload name)" },
        dry_run: DRY,
      },
    },
    handler: deletePod,
  },
  {
    name: "flux_reconcile",
    description:
      "[WRITE] Force Flux to re-apply the GitOps repo's declared state for a workload's HelmRelease " +
      "(flux reconcile helmrelease --force equivalent), reverting changes made directly in the cluster. " +
      "Use when the cluster has DRIFTED from Git (someone patched it outside GitOps) — it restores the " +
      "declared state, it never introduces a new one. Refused for workloads not managed by a Flux " +
      "HelmRelease. Only in ALLOWED_REMEDIATION_NAMESPACES. dry_run=true validates without changing anything.",
    inputSchema: {
      type: "object",
      required: ["namespace", "name"],
      properties: { namespace: NS, name: NAME, kind: KIND, dry_run: DRY },
    },
    handler: fluxReconcile,
  },
];

export default writeTools;
