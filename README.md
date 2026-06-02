# DevOps MCP Server

MCP Server for DevOps Observability — integrates with Kubernetes, Prometheus, and Loki.

## Requirements

- Node.js >= 24

## Setup

```bash
cp .env.example .env
# Edit .env with your config
npm install
npm run dev                    # development (tsx watch)
npm run build && npm start     # production
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | `dev` / `staging` / `prod` | `dev` |
| `TRANSPORT` | `stdio` or `http` | `stdio` |
| `PORT` | HTTP port | `3000` |
| `K8S_AUTH_MODE` | `kubeconfig` or `incluster` | `kubeconfig` (dev), `incluster` (staging/prod) |
| `K8S_KUBECONFIG_PATH` | Path to kubeconfig file | `~/.kube/config` |
| `K8S_API_SERVER` | Kubernetes API server URL | — |
| `K8S_TOKEN` | Service account token | — |
| `K8S_CA_CERT_PATH` | CA certificate path | — |
| `PROMETHEUS_URL` | Prometheus base URL | `http://localhost:9090` (dev) |
| `PROMETHEUS_USERNAME` | Basic auth username (optional) | — |
| `PROMETHEUS_PASSWORD` | Basic auth password (optional) | — |
| `LOKI_URL` | Loki base URL | `http://localhost:3100` (dev) |
| `LOKI_USERNAME` | Basic auth username (optional) | — |
| `LOKI_PASSWORD` | Basic auth password (optional) | — |

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
| `prometheus_get_metadata` | Metric metadata (type, unit, help text) |
| `prometheus_list_metric_names` | List all available metric names |

### Loki (6)

| Tool | Description |
|------|-------------|
| `loki_query` | Instant LogQL query |
| `loki_query_range` | Range LogQL query |
| `loki_get_labels` | List label names |
| `loki_get_label_values` | List values for a label |
| `loki_get_streams` | List active log streams |
| `loki_get_stats` | Ingestion statistics for a stream |

## Project Structure

```
src/
├── app/index.ts              # MCP server setup, tool registration, HTTP/stdio transport
├── config/index.ts           # Multi-env config (dev/staging/prod)
├── tools/
│   ├── index.ts              # Tool aggregator
│   ├── types.ts              # Shared Tool interface
│   ├── kubernetes/
│   │   ├── client.ts         # KubeConfig singleton
│   │   ├── schemas.ts        # Shared zod schemas (NS, NSLabel, NSField)
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
    ├── errors/index.ts       # Error classes + withUpstream() helper
    ├── http/index.ts         # createHttpClient with optional basic auth
    ├── loki/index.ts         # parseStreams helper
    └── logger/log.ts         # Winston logger
```

## Transport Modes

### stdio (default — local AI clients)
```json
{
  "mcpServers": {
    "devops": {
      "command": "node",
      "args": ["/path/to/devops-mcp-server/dist/index.js"],
      "env": { "NODE_ENV": "dev" }
    }
  }
}
```

### HTTP (remote deployment)
```bash
TRANSPORT=http PORT=3000 NODE_ENV=prod node dist/index.js
```

Endpoints:
- `POST /mcp` — MCP protocol endpoint (stateless, new server instance per request)
- `GET /health` — Health check

```json
{
  "mcpServers": {
    "devops": {
      "url": "https://your-domain.com/mcp"
    }
  }
}
```

## Docker

```bash
# Build
docker build -t devops-mcp-server .

# Run
docker run -p 3000:3000 \
  -e TRANSPORT=http \
  -e K8S_AUTH_MODE=incluster \
  -e PROMETHEUS_URL=http://prometheus:9090 \
  -e LOKI_URL=http://loki:3100 \
  devops-mcp-server
```

## In-Cluster Deployment (Kubernetes)

When deployed inside the same cluster, only these env vars are needed:

```bash
NODE_ENV=prod
TRANSPORT=http
PROMETHEUS_URL=http://prometheus.monitoring.svc.cluster.local:9090
LOKI_URL=http://loki.monitoring.svc.cluster.local:3100
```

`K8S_AUTH_MODE` defaults to `incluster` in prod — credentials are auto-injected by Kubernetes. Requires a ServiceAccount with ClusterRole (`get`/`list` on all resources).
