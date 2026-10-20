# Tools (55 read-only + 8 write)

Every tool is discovered by the client through `listTools()`; the agent needs no change when one is
added. Settings that shape them: [CONFIGURATION.md](CONFIGURATION.md).

## Kubernetes (37)

| Tool | Description |
|------|-------------|
| `k8s_cluster_health` | **Whole-cluster pod health in ONE call** — scans every namespace, returns only what is wrong (CrashLoopBackOff/ImagePullBackOff/OOMKilled/Pending/not-ready) + per-phase counts + `scanned` (pods, namespaces, `complete`). Every other list tool sees one namespace, so "is anything broken?" otherwise costs one call per namespace and gets answered from a partial sample. Pass `namespace` only to narrow |
| `k8s_cluster_inventory` | **Whole-cluster inventory in ONE call** — per namespace the workloads (ready/desired, images), who manages each (`managedBy`: HelmRelease+chart / Kustomization+path / Helm / unmanaged, read with the GitOps guard's own label reader), Services+ports, Ingress hosts, CronJob schedules. No env, ConfigMap or Secret content. `scanned.complete` like `k8s_cluster_health`. Without `namespace` it returns an **overview** (one line per workload + owner, Ingress hosts) because the agent caps a tool result at 8000 chars; pass `namespace` for detail, or `detail: true` for everything (the dashboard's `/cluster`). Detail entries carry `services[].serves` (workloads the selector matches) and `ingresses[].backends` (host → Service) for the dashboard's map |
| `k8s_correlate_pods` | Do several broken pods share ONE cause? Diffs the failing pods against the healthy ones in the namespace and returns what only the broken set shares (`uniqueToBroken`: node, image, ConfigMap/Secret/PVC refs, ServiceAccount, env var **names**). A lead, never a conclusion |
| `k8s_find_by_name` | Every object with this EXACT name across twelve kinds, in one namespace or all — for a request that names an object without its kind. Kinds RBAC hides are reported under `unreadable`, never as absent |
| `k8s_list_namespaces` | List all namespaces |
| `k8s_list_nodes` | List nodes with status, roles, and resource capacity |
| `k8s_describe_pod` | ONE pod's detailed status — container state/lastState (OOMKilled + exit code, CrashLoopBackOff, ImagePullBackOff), conditions, QoS, configured requests/limits, node, **+ the pod's recent events** (like `kubectl describe`). RCA workhorse (no live usage — that's Prometheus) |
| `k8s_describe_node` | ONE node's conditions (MemoryPressure/DiskPressure/PIDPressure/Ready), taints, unschedulable, capacity vs allocatable — for Pending pods / node incidents |
| `k8s_get_endpoints` | Ready vs not-ready backend addresses behind a Service (`readyCount=0` → 503 / connection-refused) |
| `k8s_get_rollout_status` | Rollout progress of ONE Deployment/StatefulSet/DaemonSet — desired vs updated/ready/available + conditions (e.g. ProgressDeadlineExceeded). For "deploy stuck" |
| `k8s_list_replicasets` | ReplicaSets with owner + revision + desired/ready — rollout history (active vs stale RS) |
| `k8s_change_timeline` | What CHANGED in a namespace in the last N hours (default 24): Deployment/StatefulSet/DaemonSet rollouts with the pod-template diff against the previous revision (image, env, args, resources, probes — secret env shows its reference only), restart-only rollouts, Flux HelmRelease upgrades (chart vs values), and referenced ConfigMaps updated. `unread` names any source that could not be read — a change there is UNKNOWN, not absent. Use first for "what changed before this broke?" |
| `k8s_list_pvs` | PersistentVolumes: phase (Bound/Released/Failed), capacity, storageClass, bound claim |
| `k8s_list_storageclasses` | StorageClasses: provisioner, default flag — PVC Pending often = no default class / broken provisioner |
| `k8s_list_network_policies` | NetworkPolicies: podSelector, policyTypes, rule counts — "traffic blocked" investigations |
| `k8s_list_pdbs` | PodDisruptionBudgets: min/maxUnavailable + disruptionsAllowed (0 blocks node drain) |
| `k8s_get_sa_permissions` | A ServiceAccount's Role/ClusterRole bindings + resolved rules — for `forbidden` RCA |
| `k8s_list_pods` | List pods in ONE namespace (filter by label). For cluster-wide "is anything broken" use `k8s_cluster_health` |
| `k8s_get_pod_logs` | Get pod logs (tail, `since_seconds`, and `previous:true` for the crashed/prior container instance — CrashLoop root cause) |
| `k8s_list_deployments` | List Deployments |
| `k8s_list_statefulsets` | List StatefulSets |
| `k8s_list_daemonsets` | List DaemonSets |
| `k8s_list_jobs` | List Jobs with status |
| `k8s_list_cronjobs` | List CronJobs with schedule |
| `k8s_list_services` | List Services with ports and external IP |
| `k8s_list_ingresses` | List Ingresses with routing rules |
| `k8s_list_hpas` | List HorizontalPodAutoscalers |
| `k8s_list_pvcs` | List PersistentVolumeClaims |
| `k8s_list_resource_quotas` | List ResourceQuotas (hard vs used) |
| `k8s_list_events` | List events — supports `since_minutes` filter |
| `k8s_list_crds` | List CustomResourceDefinitions (the types) |
| `k8s_get_custom_resources` | Read custom resource objects of any CRD (e.g. Flux HelmRelease/Kustomization) — list (compact, Ready condition) or full object by name |
| `k8s_get_resource` | Get ANY resource by `apiVersion`+`kind` — full object (spec+status) by name, or compact list. Built-ins (`v1`/`apps/v1`/…) AND custom resources; for kinds without a dedicated tool |
| `k8s_list_api_resources` | Which API groups/versions this cluster serves (`kubectl api-resources`) — core v1 kinds + every group's versions. Finds the right `apiVersion` for `k8s_get_resource` |
| `k8s_list_service_accounts` | List ServiceAccounts |
| `k8s_list_configmaps` | List ConfigMaps with keys and data |
| `k8s_list_secrets` | List Secrets (name and type only, values never exposed) |

## Prometheus (6)

| Tool | Description |
|------|-------------|
| `prometheus_query` | Instant PromQL query |
| `prometheus_query_range` | Range PromQL query |
| `prometheus_get_targets` | Scrape targets health |
| `prometheus_get_rules` | Alerting and recording rules (the rule definitions — *what is firing* is an Alertmanager question) |
| `prometheus_get_metadata` | Metric metadata |
| `prometheus_list_metric_names` | List all metric names |

## Alertmanager (1)

| Tool | Description |
|------|-------------|
| `alertmanager_get_alerts` | **Everything firing right now, cluster-wide**, in Alertmanager's own groups. Each alert carries a `status` label — `active`, `silenced` (a human muted the notification; still firing), `inhibited` (suppressed by a higher-severity alert). Optional `filter` takes Alertmanager label matchers. Returns complete `summary` counts plus per-group detail (detail capped, counts never) |

Why not Prometheus `/api/v1/alerts`: it only sees rules Prometheus itself evaluates, so the moment a
second evaluator exists (Loki Ruler, Kibana Alerting) it becomes a silently partial view that would
answer "nothing else is firing" while a log-based alert is paging. Every evaluator routes into
Alertmanager, and only Alertmanager knows about silences and inhibition. Alerts still `pending` in an
evaluator are deliberately invisible here — nothing has been routed yet.

## Loki (6)

| Tool | Description |
|------|-------------|
| `loki_query` | Instant LogQL query |
| `loki_query_range` | Range LogQL query |
| `loki_get_labels` | List label names |
| `loki_get_label_values` | List values for a label |
| `loki_get_streams` | List active log streams |
| `loki_get_stats` | Ingestion statistics |

## Tracing (3)

Backend-agnostic distributed tracing. Set `TRACING_BACKEND` to `tempo` or `jaeger`. (The OTel Collector is ingest-only — it has no query API; point `TRACING_URL` at whatever store the collector exports to.) Both backends are normalized to the same compact span shape.

| Tool | Description |
|------|-------------|
| `tracing_search` | Find slow/failing traces by service, min duration, time window (Jaeger requires `service`; Tempo optional) |
| `tracing_get_trace` | Full normalized span tree for one trace ID (service, name, durationMs, parent, error) |
| `tracing_list_services` | List service names known to the tracing backend |

## Capacity (2)

Cost/sizing questions, in `src/tools/capacity/`. `k8s_recommend_resources` is the one tool that joins two upstreams (K8s API + Prometheus) — the join is done server-side because splitting it across three model-written calls is three chances to be confidently wrong about a number that ends up in an RCA.

| Tool | Description |
|------|-------------|
| `k8s_find_unused_resources` | Orphaned/idle objects cluster-wide in one call (the `kor` question): unmounted PVCs, endpoint-less Services, workloads scaled to 0, unreferenced ConfigMaps/Secrets/ServiceAccounts. Three filters guard the claim: references from running pods **and** every workload pod template; `ownerReferences` (operator-*created*); and a match against every custom resource in the cluster (operator-*referenced*, `cross_check_crds`, default on, needs `rbac.readAllCustomResources`). `crossCheck.crdsUnreadable` non-empty ⇒ the cross-check was partial and the note says so. Still a **review** list, never a delete list |
| `k8s_recommend_resources` | Right-sizing: configured requests/limits vs real usage (CPU p95, peak working set, CFS throttle ratio over `window`, default 24h). Returns the concrete number to change per container plus cluster-wide over-reserved CPU/memory. Flags `oom_risk`, `cpu_throttled`, `*_under_provisioned`, `no_requests`, `over_provisioned`, `no_data` |

## Write tools (8)

Registered only with `MCP_ENABLE_WRITE_TOOLS=true`, every one supports `dry_run`, and only in
`ALLOWED_REMEDIATION_NAMESPACES`. In `devops-ai-agent` nothing calls them without a human clicking
*Approve* on a dry-run-validated card.

| Tool | Description |
|------|-------------|
| `k8s_rollout_restart` | Restart a Deployment/StatefulSet/DaemonSet (reconcile-safe, allowed on GitOps-managed workloads) |
| `k8s_rollout_undo` | Roll a Deployment back to an earlier revision's pod template (kubectl rollout undo --to-revision equivalent) — undoes a bad env/args/resources/probe change, which a set_image cannot when every image is :latest. Deployments only. Refused on Flux-managed workloads (dry run returns a GitOps preview carrying `fromRevision`/`toRevision` instead; the undo there is a revert PR). Optional `from_revision`: the live revision the approval was proposed against — the JSON patch tests the revision annotation first, so if the Deployment moved since, the API server rejects it and nothing changes |
| `k8s_set_image` | Change one container's image. `container` optional on a single-container workload. Refused on Flux/Helm-managed workloads |
| `k8s_set_resources` | Patch requests/limits — only the values given. Refused on Flux/Helm-managed workloads |
| `k8s_scale` | Change replicas within `MAX_SCALE_DELTA`; zero only with `quarantine: true` (reversible "looks unused"). Refused on Flux/Helm-managed workloads |
| `k8s_delete_pod` | Delete ONE controller-owned pod (its controller recreates it) |
| `k8s_delete_orphan` | Delete ONE object nothing declares (ConfigMap, Service, ServiceAccount, or a workload already at 0). Returns `backupManifest`, captured immediately before the delete. Never Secrets or PVCs |
| `flux_reconcile` | Force Flux to re-apply the declared state of a workload's HelmRelease — the fix for drift. Needs `patch` on `helmreleases` |
