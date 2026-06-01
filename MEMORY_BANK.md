# Memory Bank — devops-mcp-server

## Project Overview
MCP (Model Context Protocol) server for DevOps observability. Exposes 32 tools callable by AI agents to query Kubernetes, Prometheus, and Loki.

## Tech Stack
- **Runtime:** Node.js >= 24, TypeScript (ESM, `"type": "module"`)
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.29.0
- **K8s Client:** `@kubernetes/client-node` v1.4.0 (ESM-only, requires Node 18+)
- **HTTP:** Express v5
- **Build:** `tsc` → `dist/`, dev via `tsx watch`

## Transport Modes
- `TRANSPORT=stdio` — default, for local AI clients (Claude Desktop, Cursor)
- `TRANSPORT=http` — for remote deployment, endpoint `POST /mcp`
- **Bug fix applied:** HTTP mode creates a new `McpServer` per request (stateless) because the SDK does not allow reconnecting to an already-connected server instance

## Tools (32 total)

### Kubernetes (19)
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

**`k8s_list_events` special:** has a `since_minutes` parameter to filter events within the last N minutes (post-filtered in the handler since the K8s API does not support native time filtering).

### Prometheus (7)
`prometheus_query`, `prometheus_query_range`, `prometheus_get_alerts`, `prometheus_get_targets`, `prometheus_get_rules`, `prometheus_get_metadata`, `prometheus_list_metric_names`

### Loki (6)
`loki_query`, `loki_query_range`, `loki_get_labels`, `loki_get_label_values`, `loki_get_streams`, `loki_get_stats`

## Architecture Patterns

### withUpstream helper
All handlers use `withUpstream(service, label, fn)` from `src/utils/errors/index.ts` to wrap try/catch — eliminates duplicated error handling across 19+ handlers.

### Shared Schemas (Kubernetes)
`src/tools/kubernetes/schemas.ts` exports `NS`, `NSLabel`, `NSField` — zod schemas reused across handlers.

### Config (Multi-env)
`src/config/index.ts` — plain object per env (`dev`/`staging`/`prod`), no library dependency. Dev defaults to `kubeconfig` + localhost URLs; staging/prod default to `incluster`.

### K8s Auth
- `dev`: `kubeconfig` from `~/.kube/config`
- `staging`/`prod`: `incluster` — reads token from `/var/run/secrets/kubernetes.io/serviceaccount/`
- Requires ServiceAccount + ClusterRole with `get`/`list` verbs on all resources

## Known Issues / Notes
- `@kubernetes/client-node` v1.x API uses named params objects (not positional args like v0.x)
- `k8s_list_secrets` returns name + type only — values are never exposed (security)
- HTTP mode: each request creates a new McpServer — small overhead but necessary

## File Structure
```
src/
├── app/index.ts              # McpServer setup, tool registration, HTTP/stdio transport
├── config/index.ts           # Multi-env config
├── tools/
│   ├── index.ts              # Aggregator [...k8s, ...prometheus, ...loki]
│   ├── types.ts              # Tool interface
│   ├── kubernetes/
│   │   ├── client.ts         # KubeConfig singleton + getApi()
│   │   ├── schemas.ts        # NS, NSLabel, NSField
│   │   ├── index.ts          # Tool definitions
│   │   └── handlers/         # Per-domain handler files
│   ├── prometheus/
│   │   ├── client.ts         # axios singleton
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
    └── logger/log.ts         # Winston logger
```

## Potential Improvements
- [ ] Add resource pressure metrics to `k8s_list_nodes` (CPU/memory usage vs allocatable)
- [ ] Add `k8s_exec_pod` for running commands (requires careful security consideration)
- [ ] Add `prometheus_get_series` for label cardinality analysis
- [ ] Rate limiting for HTTP mode
- [ ] Health check endpoint that verifies connectivity to K8s/Prometheus/Loki
- [ ] Session-based HTTP transport (for stateful multi-turn MCP sessions)
