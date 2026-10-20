# DevOps MCP Server

MCP Server for DevOps Observability — integrates with Kubernetes, Prometheus, Alertmanager, Loki and Tempo/Jaeger. Consumed by
[devops-ai-agent](../devops-ai-agent) over MCP (stdio or HTTP); any MCP client works.

## Requirements

- Node.js >= 24

## Setup

```bash
cp .env.example .env           # every variable: docs/CONFIGURATION.md
npm install
npm run dev                    # development (tsx watch)
npm run build && npm start     # production
npm test                       # unit tests
```

`npm test` runs `node --import tsx --test 'src/**/*.test.ts'` — Node's built-in test runner (Node >= 24), no extra dependencies. Test files (`*.test.ts`) are excluded from the production build. Covered: tool schemas, every write-tool guardrail (namespace allowlist, GitOps verdict, scale bounds, orphan refusals), the cluster health/inventory scans, pod correlation, find-by-name, rightsizing and the unused scan, the explained-empty Loki/Prometheus answers, the Alertmanager grouping and the tracing adapters, `/mcp` auth and the upstream timeout.

## Tools (55 read-only + 8 write)

| Domain | Tools | Highlights |
|---|---|---|
| Kubernetes | 37 | `k8s_cluster_health` and `k8s_cluster_inventory` scan the whole cluster in one call; `k8s_change_timeline`, `k8s_correlate_pods`, `k8s_describe_pod`, `k8s_get_pod_logs` |
| Prometheus | 6 | `prometheus_query`, `prometheus_query_range`, targets, rules, metadata |
| Alertmanager | 1 | `alertmanager_get_alerts` — everything firing, with silenced/inhibited labelled |
| Loki | 6 | `loki_query`, `loki_query_range`, labels, streams, stats |
| Tracing | 3 | `tracing_search`, `tracing_get_trace`, `tracing_list_services` (Tempo or Jaeger) |
| Capacity | 2 | `k8s_find_unused_resources`, `k8s_recommend_resources` |
| Write | 8 | Registered only with `MCP_ENABLE_WRITE_TOOLS=true`; dry-run first, namespace allowlist, GitOps guard |

Every tool with its description: [docs/TOOLS.md](docs/TOOLS.md).

## MCP Client Config

### stdio
```json
{
  "mcpServers": {
    "devops": {
      "command": "node",
      "args": ["/path/to/devops-mcp-server/dist/index.js"]
    }
  }
}
```

### HTTP
```json
{
  "mcpServers": {
    "devops": { "url": "https://your-domain.com/mcp" }
  }
}
```

## Docker

```bash
docker build -t devops-mcp-server .

docker run -p 3000:3000 \
  -e TRANSPORT=http \
  -e K8S_AUTH_MODE=incluster \
  -e PROMETHEUS_URL=http://prometheus:9090 \
  -e LOKI_URL=http://loki:3100 \
  devops-mcp-server
```

## In-Cluster Deployment

```bash
TRANSPORT=http
K8S_AUTH_MODE=incluster
PROMETHEUS_URL=http://prometheus.monitoring.svc.cluster.local:9090
LOKI_URL=http://loki.monitoring.svc.cluster.local:3100
```

Requires a ServiceAccount with ClusterRole (`get`/`list` on all resources), plus the write verbs
if write tools are enabled. In this workspace it is deployed as part of the umbrella chart
`devops-ai-helm-charts/charts/devops-ai-stack`, which renders that RBAC.

## Project Structure

```
src/
├── app/index.ts              # McpServer, HTTP/stdio transport, graceful shutdown
├── config/index.ts           # Flat env-var config (no env-conditional logic)
├── tools/
│   ├── kubernetes/
│   │   ├── client.ts, schemas.ts, index.ts
│   │   ├── write.ts          # [WRITE] tools (MCP_ENABLE_WRITE_TOOLS)
│   │   ├── guardrails.ts     # Namespace allowlist, GitOps verdict, scale bounds
│   │   ├── podspec.ts, provenance.ts  # Shared reference walker / managedBy reader
│   │   └── handlers/         # Per-domain: health, inventory, correlate, find, pods, workloads...
│   ├── prometheus/
│   ├── alertmanager/
│   ├── loki/
│   ├── tracing/              # Tempo + Jaeger adapters
│   └── capacity/             # Unused scan + rightsizing
└── utils/
    ├── errors/index.ts       # withUpstream() helper
    ├── http/index.ts         # createHttpClient()
    ├── loki/index.ts         # parseStreams(), explained-empty answer (noLogLines contract)
    ├── prometheus/index.ts   # explained-empty answer (unknown_metric / didYouMean)
    ├── timeout/index.ts      # withTimeout() — UPSTREAM_TIMEOUT_SECONDS
    └── logger/log.ts         # Winston + logWithContext()
```
