# DevOps MCP Server

MCP Server for DevOps Observability — integrates with Kubernetes, Prometheus, and Loki.

## Requirements

- Node.js >= 24

## Setup

```bash
cp .env.example .env
npm install
npm run dev                    # development (tsx watch)
npm run build && npm start     # production
npm test                       # unit tests
```

## Testing

`npm test` runs `node --import tsx --test 'src/**/*.test.ts'` — Node's built-in test runner (Node >= 24), no extra dependencies. Test files (`*.test.ts`) are excluded from the production build. Current coverage: the `withTimeout` upstream-timeout helper.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `TRANSPORT` | `stdio` or `http` | `stdio` |
| `PORT` | HTTP port | `3000` |
| `K8S_AUTH_MODE` | `kubeconfig` or `incluster` | `kubeconfig` |
| `K8S_KUBECONFIG_PATH` | Path to kubeconfig | `~/.kube/config` |
| `K8S_API_SERVER` | Kubernetes API server URL | — |
| `K8S_TOKEN` | Service account token | — |
| `PROMETHEUS_URL` | Prometheus base URL | `http://localhost:9090` |
| `PROMETHEUS_USERNAME` | Basic auth (optional) | — |
| `PROMETHEUS_PASSWORD` | Basic auth (optional) | — |
| `LOKI_URL` | Loki base URL | `http://localhost:3100` |
| `LOKI_USERNAME` | Basic auth (optional) | — |
| `LOKI_PASSWORD` | Basic auth (optional) | — |
| `UPSTREAM_TIMEOUT_SECONDS` | Max wait on any upstream (K8s/Prometheus/Loki) before failing the tool | `30` |
| `K8S_LIST_LIMIT` | Cap on items returned by namespaced list tools (pods/events/configmaps/secrets) | `100` |
| `LOG_LEVEL` | `error\|warn\|info\|http\|debug` | `debug` (dev), `info` (prod) |

## Tools (32)

### Kubernetes (19)

| Tool | Description |
|------|-------------|
| `k8s_list_namespaces` | List all namespaces |
| `k8s_list_nodes` | List nodes with status, roles, and resource capacity |
| `k8s_list_pods` | List pods (filter by namespace/label) |
| `k8s_get_pod_logs` | Get pod logs (with tail support) |
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
| `k8s_list_crds` | List CustomResourceDefinitions |
| `k8s_list_service_accounts` | List ServiceAccounts |
| `k8s_list_configmaps` | List ConfigMaps with keys and data |
| `k8s_list_secrets` | List Secrets (name and type only, values never exposed) |

### Prometheus (7)

| Tool | Description |
|------|-------------|
| `prometheus_query` | Instant PromQL query |
| `prometheus_query_range` | Range PromQL query |
| `prometheus_get_alerts` | Active alerts |
| `prometheus_get_targets` | Scrape targets health |
| `prometheus_get_rules` | Alerting and recording rules |
| `prometheus_get_metadata` | Metric metadata |
| `prometheus_list_metric_names` | List all metric names |

### Loki (6)

| Tool | Description |
|------|-------------|
| `loki_query` | Instant LogQL query |
| `loki_query_range` | Range LogQL query |
| `loki_get_labels` | List label names |
| `loki_get_label_values` | List values for a label |
| `loki_get_streams` | List active log streams |
| `loki_get_stats` | Ingestion statistics |

## Project Structure

```
src/
├── app/index.ts              # McpServer, HTTP/stdio transport, graceful shutdown
├── config/index.ts           # Flat env-var config (no env-conditional logic)
├── tools/
│   ├── kubernetes/
│   │   ├── client.ts, schemas.ts, index.ts
│   │   └── handlers/         # Per-domain: namespaces, nodes, pods, workloads...
│   ├── prometheus/
│   └── loki/
└── utils/
    ├── errors/index.ts       # withUpstream() helper
    ├── http/index.ts         # createHttpClient()
    ├── loki/index.ts         # parseStreams()
    └── logger/log.ts         # Winston + logWithContext()
```

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

Requires a ServiceAccount with ClusterRole (`get`/`list` on all resources).
