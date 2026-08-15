# Memory Bank — devops-mcp-server

## Project Overview
MCP (Model Context Protocol) server for DevOps observability. Exposes 48 tools callable by AI agents to query Kubernetes, Prometheus, Loki, and distributed tracing (Tempo/Jaeger).

## Tech Stack
- **Runtime:** Node.js >= 24, TypeScript (ESM, `"type": "module"`)
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.29.0
- **K8s Client:** `@kubernetes/client-node` v1.4.0 (ESM-only, requires Node 18+)
- **HTTP:** Express v5
- **Build:** `tsc` → `dist/`, dev via `tsx watch`

## 12-Factor App Compliance
- **Factor 3 (Config):** All config is flat env vars — no env-conditional logic in code. `NODE_ENV` is no longer used to change behavior.
- **Factor 9 (Disposability):** `SIGTERM`/`SIGINT` → `app.stop()` closes HTTP server gracefully before `process.exit(0)`.
- **Factor 10 (Dev/prod parity):** Same defaults work in all envs — behavior controlled entirely by env vars.
- **Factor 11 (Logs):** Winston to stdout, `LOG_LEVEL` env var overrides default.

## Transport Modes
- `TRANSPORT=stdio` — default, for local AI clients (Claude Desktop, Cursor)
- `TRANSPORT=http` — for remote deployment, endpoint `POST /mcp`
- **Bug fix applied:** HTTP mode creates a new `McpServer` per request (stateless) because the SDK does not allow reconnecting to an already-connected server instance

## Tools (48 read-only, 54 with `MCP_ENABLE_WRITE_TOOLS=true`)

Counts verified by importing `src/tools/index.ts` — the tables below list the main ones per
domain, not every handler. The write tools are the 6 in `kubernetes/write.ts`.

### Kubernetes
Handlers split per domain under `src/tools/kubernetes/handlers/`:

| File | Tools |
|------|-------|
| `namespaces.ts` | `k8s_list_namespaces` |
| `nodes.ts` | `k8s_list_nodes` |
| `pods.ts` | `k8s_list_pods`, `k8s_get_pod_logs` |
| `workloads.ts` | `k8s_list_deployments`, `k8s_list_statefulsets`, `k8s_list_daemonsets` |
| `batch.ts` | `k8s_list_jobs`, `k8s_list_cronjobs` |
| `networking.ts` | `k8s_list_services`, `k8s_list_ingresses` |
| `autoscaling.ts` | `k8s_list_hpas` |
| `storage.ts` | `k8s_list_pvcs` |
| `quotas.ts` | `k8s_list_resource_quotas` |
| `events.ts` | `k8s_list_events` |
| `crds.ts` | `k8s_list_crds` |
| `serviceaccounts.ts` | `k8s_list_service_accounts` |
| `configs.ts` | `k8s_list_configmaps`, `k8s_list_secrets` (values never exposed) |

**`k8s_list_events` special:** has a `since_minutes` parameter to filter events within the last N minutes (post-filtered in handler since K8s API does not support native time filtering).

### Prometheus (7)
`prometheus_query`, `prometheus_query_range`, `prometheus_get_alerts`, `prometheus_get_targets`, `prometheus_get_rules`, `prometheus_get_metadata`, `prometheus_list_metric_names`

### Loki (6)
`loki_query`, `loki_query_range`, `loki_get_labels`, `loki_get_label_values`, `loki_get_streams`, `loki_get_stats`

### Tracing (3)
`tracing_search`, `tracing_get_trace`, `tracing_list_services` — backend-agnostic distributed tracing under `src/tools/tracing/`.
- **Backend selection:** `TRACING_BACKEND=tempo|jaeger`, `TRACING_URL` required (tools throw `ValidationError` until set). OTel Collector is ingest-only (no query API) → point `TRACING_URL` at the store the collector exports to.
- **Adapter pattern (`adapters.ts`):** Tempo (TraceQL search + OTLP/JSON trace) and Jaeger (Query API) normalized to one compact shape (`TraceSummary`, `NormalizedSpan`) — keeps tokens bounded (agent truncates at 8000 chars) and lets one prompt playbook serve both. `normalizeOtlp` + `jaegerAdapter`/`tempoAdapter` are unit-tested in `adapters.test.ts`.
- **Time/units:** handler accepts RFC3339 or Unix seconds; adapters convert (Tempo→seconds, Jaeger→microseconds). `minDurationMs` → `<n>ms` Go-duration string for both. Jaeger search **requires** `service`; Tempo optional.
- Agent system prompt (`devops-ai-agent/prompts/system.md`) updated: High Latency playbook now chains metrics→`tracing_search`→`tracing_get_trace`, plus a Tracing tool-usage section.

## Architecture Patterns

### withUpstream helper
All handlers use `withUpstream(service, label, fn)` from `src/utils/errors/index.ts` to wrap try/catch — eliminates duplicated error handling.
- **`conciseCause()`** (unit-tested) makes upstream errors token-cheap: K8s `ApiException` embeds the whole HTTP exchange (status line, escaped body, headers, audit-id) in `.message` — only the API's own `body.message` ("pods \"x\" not found") is kept; otherwise the message is cut before the `Body:`/`Headers:` dump. The original error stays attached as `cause`.
- **axios branch (`err.response.data`) — added after it bit every HTTP upstream.** Prometheus, Loki and tracing all go through axios, whose `.message` is only `"Request failed with status code 400"`; the upstream's actual explanation lives in `response.data` (`{status:"error", error:"1:9: parse error..."}` for Prometheus, `{message}` or plain text for Loki). Without this branch a malformed PromQL/LogQL came back to the model as a bare status code, so it learned nothing and **retried the same broken query**. Now: `400 1:9: parse error: unexpected ")"`.
- **Tool-failure logs skip the stack for expected errors** (`UpstreamError`/`ValidationError` = operational failures → one line); unexpected errors keep the stack — those are actual bugs.

### Write tools (Guarded Remediation)
- `kubernetes/write.ts`: **6 typed actions** — `k8s_rollout_restart` (deployment/sts/ds via restartedAt annotation), `k8s_set_image` (one container's image; reports previous → new), `k8s_set_resources` (requests/limits, only provided values patched), `k8s_scale` (deployment/sts only — ds has no replicas; bounded by `MAX_SCALE_DELTA`, scale-to-zero always refused), `k8s_delete_pod` (ONE wedged pod; refused without a recreating controller — `findRecreatingOwner`, unit-tested; Job/naked pods excluded; no GitOps guard, recreation is reconcile-safe), `flux_reconcile` (below). **Never a generic patch tool** — that would be arbitrary kubectl in disguise. Registered ONLY when `MCP_ENABLE_WRITE_TOOLS=true` (conditional spread in `tools/index.ts` — never listed otherwise; a listed-but-refusing tool makes the agent's LLM loop).
- **Description convention: every write tool MUST start with `[WRITE]`** — the agent filters these out of its agentic loop by that prefix; they are only callable via the approval flow. Breaking the convention silently hands the model unguarded execution.
- Server-side guardrails (`guardrails.ts`, unit-tested): `ALLOWED_REMEDIATION_NAMESPACES` allowlist (empty = all blocked) + always-blocked `kube-system`/`kube-public`/`kube-node-lease`/`flux-system`. Enforced here because this server holds the cluster creds — agent checks are UX only. RBAC is the floor beneath.
- Dry-run = K8s server-side `dryRun: "All"` on the same patch (full validation, zero change).
- **Guardrail refusals pass through `withUpstream` unwrapped** (`ValidationError` re-thrown as-is): they are complete user-facing sentences, and the "Failed to set image on X:" prefix duplicated the target in Slack. Workload identifiers in error labels are backticked (`` deployment `ns/name` ``) — they render as code in Slack.
- **GitOps guard** (`gitOpsVerdict`, unit-tested): the spec-mutating actions (`set_image`/`set_resources`/`scale`) read the workload's Flux/Helm labels and return a structured verdict (`managed`/`prEligible`/`source`/`helmRelease`). `rollout_restart`/`delete_pod` are exempt (reconcile-safe). Behavior per source:
  - **Flux HelmRelease** (`helm.toolkit.fluxcd.io/name`) = **PR-eligible** (v2 target). On a **dry-run** the handler returns a structured **PR preview** `{gitOpsPrEligible, source, helmRelease:{name,namespace}, workload, action, container?, changes:[{field,from,to}], message}` instead of patching — Step 4's agent routes it over SQS to the private-network GitOps handler (`DESIGN_gitops_pr_remediation.md`). On **execute** it refuses (a direct patch is never allowed on a GitOps workload).
  - **Flux Kustomization** (raw-manifest PR flow is a later phase) and **plain Helm** (`managed-by: Helm`, not git-backed) = managed but NOT PR-eligible → refuse with the owning object named.
  - The old `assertNotGitOpsManaged` (throw-only) was replaced by `gitOpsVerdict` + the handler-local `gitOpsPreviewOrRefuse`. `resourceChanges` (exported, tested) builds the set_resources preview changes from the container's current resources.
- **`flux_reconcile` — the inverse write tool (cluster ← GitOps repo).** Every other write tool introduces new state; this one forces Flux to re-apply the state the repo **already declares**, which is the correct fix when somebody changed the cluster directly (`kubectl set image` on a Flux-managed workload). That is why it is the one spec-affecting action NOT refused by the GitOps guard.
  - Input is the **workload** (`namespace`/`name`/`kind`), never a HelmRelease. The target release is derived from the workload's own `helm.toolkit.fluxcd.io/*` labels via `gitOpsVerdict`, so the tool cannot be aimed at an arbitrary release (including Flux's own).
  - **The namespace guard runs on the WORKLOAD's namespace, not the HelmRelease's** — HelmReleases usually live in `flux-system`, which is permanently blocked, so guarding on their namespace would make the tool unusable. The blast radius of a reconcile is whatever the release manages, i.e. the workload namespace. This is the only write tool that touches an object in `flux-system`; the derivation above is what keeps that safe.
  - Sets BOTH `reconcile.fluxcd.io/requestedAt` and `reconcile.fluxcd.io/forceAt` (= `flux reconcile helmrelease --force`). `requestedAt` alone only re-evaluates the release; in-cluster drift is reverted by the **forced helm upgrade** that `forceAt` triggers.
  - The HelmRelease API version is read from the CRD's storage version, not hardcoded — Flux moved `v2beta1 → v2beta2 → v2` and clusters here run mixed Flux versions (dev v2.9.0, stg/prd v2.4.0). CRs need `PatchStrategy.MergePatch` (strategic-merge is not supported for custom resources).
  - **RBAC:** needs `patch` on `helm.toolkit.fluxcd.io/helmreleases` (was `get` only) plus the existing `get` on `customresourcedefinitions`. Added to the dev overlay in `gitops-devops-ai-manifest`; **stg/prd still need it**.
- **`container` is optional** in `k8s_set_image`/`k8s_set_resources` (`findContainer`, unit-tested): omitted → auto-resolved when the workload has exactly one container; multi-container → refused listing the names; wrong name → refused listing what exists. Rationale: the agent's proposal model cannot know container names (not in its context) and guessed one from the workload name during live testing.

### Workload listings include containers
`k8s_list_deployments/statefulsets/daemonsets` return `containers: [{name, image}]` per
workload. Without them the model literally could not answer "what image tag runs where"
(it pasted kubectl how-tos instead), the proposal model could not follow "keep the current
repository, change only the tag" (it invented `nginx:latest` for the ingress controller),
and it nagged users for container names. One listing call now carries everything.

### Detail readers (`describe.ts`) — depth the list tools omit
`k8s_describe_pod` / `k8s_describe_node` / `k8s_get_endpoints` read ONE object in detail (vs the
list tools' summary rows). **Deliberately state/config only — NO live CPU/memory usage** (that's
Prometheus/metrics-server; duplicating it would overlap). Shape functions (`shapePodDetail`,
`shapeNodeDetail`, `shapeEndpoints`) are pure + unit-tested. describe_pod surfaces the RCA
ground-truth the list view hides: container `state`/`lastState` → "Terminated: OOMKilled (exit
137)" / "Waiting: CrashLoopBackOff", conditions, QoS, configured requests/limits. describe_node →
conditions (MemoryPressure/…), taints, capacity vs allocatable. get_endpoints → ready vs
not-ready backends (readyCount=0 = the Service has no healthy pods → 503). The agent's system.md
Failure Mode Playbooks now lead crash/OOM/not-ready/pending/503 with these.

### Tier-2 investigation readers (state/config, no Prometheus overlap)
Added alongside the detail readers — all read-only K8s state, **no live usage metrics** (that
stays Prometheus; `k8s_top`/metrics-server was deliberately NOT added to avoid overlap):
- **`rollout.ts`** — `k8s_get_rollout_status` (deploy/sts/ds, normalized desired/updated/ready/available + conditions + `complete` flag; `shapeRollout` pure+tested, handles the daemonset `numberScheduled` fields) + `k8s_list_replicasets` (rollout history).
- **`storage.ts`** (+PVCs) — `k8s_list_pvs` (phase/claim/SC) + `k8s_list_storageclasses` (provisioner/default).
- **`networking.ts`** (+ing/svc) — `k8s_list_network_policies`.
- **`policy.ts`** — `k8s_list_pdbs` (disruptionsAllowed=0 blocks drains).
- **`rbac.ts`** — `k8s_get_sa_permissions` (SA → RoleBinding/ClusterRoleBinding → resolved rules; `subjectMatchesSa` pure+tested; no SubjectAccessReview — just reads bindings). RBAC: these read verbs on replicasets/pv/storageclasses/networkpolicies/pdbs/rolebindings/clusterrolebindings/roles/clusterroles — grant `get`/`list` if scoped RBAC is used.
- Agent system.md gained playbooks: rollout-stuck, PVC-Pending, forbidden (SA perms), traffic-blocked (netpol).

### Discovery + generic reads (gap-close vs public K8s MCP servers)
Benchmarked against `containers/kubernetes-mcp-server` (manusa) and `Flux159/mcp-server-kubernetes`.
Added the cheap, investigation-focused gaps; skipped `pods_exec` (security), `pods_top`/`nodes_top`
(Prometheus overlap), and raw `apply`/`patch` (we do guarded writes + GitOps PR-flow instead):
- **`get_pod_logs` gained `previous:true` + `since_seconds`** — the crashed/prior container instance. The current logs are the fresh restart; the CrashLoop root cause is in the *previous* one. ~3 lines, no new tool.
- **`describe_pod` now inlines the pod's recent events** (`shapeEvents`, newest-first, capped 10) — like real `kubectl describe`. Best-effort (`.catch(()=>[])`) so missing events-RBAC never fails the describe. `involvedObject.kind=Pod` in the field selector.
- **`k8s_get_resource`** (`crds.ts`) — generic get by `apiVersion`+`kind` via `KubernetesObjectApi.read/list` (resolves core-vs-group path via discovery, so `v1` AND `apps/v1` both work). Full object by name, compact list otherwise. For any kind without a dedicated tool. Note: `k8s_get_custom_resources` (CustomObjectsApi) already handled every *grouped* CRD; this adds core + a friendlier apiVersion+kind signature.
- **`k8s_list_api_resources`** — `CoreV1Api.getAPIResources()` (core v1 kinds, subresources filtered) + `ApisApi.getAPIVersions()` (all groups+versions). Cluster-specific GVK map to drive `k8s_get_resource`. Deliberately does NOT enumerate every group's resources (N discovery calls, low marginal value — the LLM knows standard kinds; CRD plurals come from `k8s_list_crds`).

### Custom resources (`k8s_get_custom_resources`, read-only)
Generic reader over `CustomObjectsApi` for ANY CRD's objects (not just the type
definitions `k8s_list_crds` already covered) — Flux `HelmRelease`/`Kustomization`,
cert-manager `Certificate`, etc. `{group, version, plural}` + optional `namespace`/`name`.
No `name` → compact list (`compactCustomResources`, unit-tested: name/namespace/Ready
condition + 200-char-capped message/age) so a big list doesn't flood the context; `name`
set → the full object (spec + status) — e.g. a HelmRelease's chart/values/sourceRef. Not
a `[WRITE]` tool (read-only) — this is v2 GitOps-remediation groundwork (design doc §10):
read the owning HelmRelease before the PR-flow can be built.

### Startup upstream probe
`_checkUpstreams()` (app/index.ts) GETs every configured HTTP upstream (Prometheus, Loki, tracing) at startup with a 5s timeout. Any HTTP response counts as reachable (it detects DNS/connect/timeout misconfig, not app health). Unreachable → `Upstream UNREACHABLE` **warn** — deliberately non-fatal: Prometheus being down must not take the k8s tools down with it. Surfaces a wrong `PROMETHEUS_URL` at deploy time instead of at the first tool call. `/health` intentionally does NOT include upstreams (partial availability > all-or-nothing readiness).

### Timeouts & List Limits
- `UPSTREAM_TIMEOUT_SECONDS` (default 30, converted to ms in config) bounds every upstream call:
  - Prometheus/Loki: passed as axios `timeout` in `createHttpClient()`
  - K8s list calls: passed as `timeoutSeconds` (server-side)
  - **Universal net:** `app/index.ts` wraps every `tool.handler(args)` in `withTimeout()` (`src/utils/timeout/index.ts`) at the upstream timeout + 5s — catches anything that ignores its own timeout (e.g. pod logs, which have no server-side timeout)
- `K8S_LIST_LIMIT` (default 100) caps namespaced list responses (`pods`, `events`, `configmaps`, `secrets`) via the K8s `limit` param — a huge namespace used to return a response so large the agent truncated it to 8000 chars and fed the LLM broken JSON. Same pattern can be extended to the remaining list tools.
- **Why timeouts matter:** axios and the K8s client default to NO timeout — a hung (not errored) upstream would block the tool call, and the agent awaiting it, indefinitely.

### Testing
- `npm test` → `node --import tsx --test 'src/**/*.test.ts'` (Node >= 24 built-in runner + tsx, zero new deps)
- `*.test.ts` excluded from the `tsc` build so `dist/` stays clean
- Covered so far: `withTimeout` / `TimeoutError`

### Shared Schemas (Kubernetes)
`src/tools/kubernetes/schemas.ts` exports `NS`, `NSLabel`, `NSField` — zod schemas reused across handlers.

### Config (Flat env vars)
`src/config/index.ts` — single flat config object from env vars. No per-env conditionals. All defaults are reasonable for local dev.

### K8s Auth
- `K8S_AUTH_MODE=kubeconfig` (default) — reads `~/.kube/config`
- `K8S_AUTH_MODE=incluster` — reads token from `/var/run/secrets/kubernetes.io/serviceaccount/`
- Requires ServiceAccount + ClusterRole with `get`/`list` on all resources for in-cluster mode

## File Structure
```
src/
├── app/index.ts              # McpServer, tool registration, HTTP/stdio, graceful shutdown
├── config/index.ts           # Flat env-var config
├── tools/
│   ├── index.ts              # Aggregator
│   ├── types.ts              # Tool interface
│   ├── kubernetes/
│   │   ├── client.ts         # KubeConfig singleton + getApi()
│   │   ├── schemas.ts        # NS, NSLabel, NSField
│   │   ├── index.ts          # Tool definitions
│   │   └── handlers/         # Per-domain handler files
│   ├── prometheus/
│   │   ├── client.ts
│   │   ├── handlers.ts
│   │   └── index.ts
│   └── loki/
│       ├── client.ts
│       ├── handlers.ts
│       └── index.ts
└── utils/
    ├── errors/index.ts       # UpstreamError, ValidationError, withUpstream()
    ├── http/index.ts         # createHttpClient(url, auth?)
    ├── loki/index.ts         # parseStreams()
    └── logger/log.ts         # Winston logger, logWithContext(), LOG_LEVEL support
```

## Known Issues / Notes
- `@kubernetes/client-node` v1.x API uses named params objects (not positional args like v0.x)
- `k8s_list_secrets` returns name + type only — values never exposed
- HTTP mode: each request creates a new McpServer — small overhead but necessary
- **Tracing timestamps are defensive now:** a span with a missing/junk `startTimeUnixNano` used to hit `new Date(NaN).toISOString()` → `RangeError`, killing the whole tool call over one bad span; and a single `NaN` poisoned `Math.max/min` in `summarize()` so the trace duration became `NaN`. Invalid timestamps become `""`, are excluded from the duration bounds, and the span is still returned.
- **Correlation ids:** HTTP mode stamps a per-request UUID (`req.id`) onto every tool call. stdio mode used ONE startup UUID for the whole process lifetime, making calls indistinguishable — it now generates one per call (`correlationId ?? crypto.randomUUID()`).
- **Tool args are repeated on the failure log.** They were logged at `debug` only, so in prod (`info`) a `Tool failed:` line arrived with no way to tell which call broke.

## Observability
- `logWithContext(level, msg, {correlationId, toolName, duration, status, ...})` → `ts [LEVEL] k=v ... message`. Stacks come from `winston.format.errors({stack:true})`; expected failures (`UpstreamError`/`ValidationError`) deliberately omit them.
- The agent's Slack `threadId` does NOT reach this server: `StreamableHTTPClientTransport` accepts headers only at construction, not per call. Join agent↔server logs on tool name + input + timestamp (both sides log all three).

## Potential Improvements
- [ ] Add resource pressure metrics to `k8s_list_nodes` (CPU/memory usage vs allocatable)
- [ ] Add `prometheus_get_series` for label cardinality analysis
- [ ] Rate limiting for HTTP mode
- [ ] Health check endpoint that verifies connectivity to K8s/Prometheus/Loki
- [ ] Session-based HTTP transport (stateful multi-turn MCP sessions)
