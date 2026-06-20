# Memory Bank — devops-mcp-server

## Project Overview
MCP (Model Context Protocol) server for DevOps observability. Exposes 32 tools callable by AI agents to query Kubernetes, Prometheus, and Loki.

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

**`k8s_list_events` special:** has a `since_minutes` parameter to filter events within the last N minutes (post-filtered in handler since K8s API does not support native time filtering).

### Prometheus (7)
`prometheus_query`, `prometheus_query_range`, `prometheus_get_alerts`, `prometheus_get_targets`, `prometheus_get_rules`, `prometheus_get_metadata`, `prometheus_list_metric_names`

### Loki (6)
`loki_query`, `loki_query_range`, `loki_get_labels`, `loki_get_label_values`, `loki_get_streams`, `loki_get_stats`

## Architecture Patterns

### withUpstream helper
All handlers use `withUpstream(service, label, fn)` from `src/utils/errors/index.ts` to wrap try/catch — eliminates duplicated error handling.

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

## Potential Improvements
- [ ] Add resource pressure metrics to `k8s_list_nodes` (CPU/memory usage vs allocatable)
- [ ] Add `prometheus_get_series` for label cardinality analysis
- [ ] Rate limiting for HTTP mode
- [ ] Health check endpoint that verifies connectivity to K8s/Prometheus/Loki
- [ ] Session-based HTTP transport (stateful multi-turn MCP sessions)
