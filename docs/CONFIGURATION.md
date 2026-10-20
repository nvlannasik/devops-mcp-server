# Configuration

Every setting is an environment variable (`cp .env.example .env` for local dev). The tools these
shape: [TOOLS.md](TOOLS.md).

## Transport and auth

| Variable | Description | Default |
|----------|-------------|---------|
| `TRANSPORT` | `stdio` or `http` | `stdio` |
| `PORT` | HTTP port | `3000` |
| `MCP_AUTH_TOKEN` | Bearer token required on `/mcp` (http transport). Unset = open + a startup warning. `/health` stays unauthenticated for probes | — |

## Write tools

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_ENABLE_WRITE_TOOLS` | `true` registers the eight `[WRITE]` tools (see [Write tools](TOOLS.md#write-tools-8)). Off = not even listed | `false` |
| `ALLOWED_REMEDIATION_NAMESPACES` | Comma-separated namespaces write tools may target. **Empty = all blocked.** `kube-system`/`kube-public`/`kube-node-lease`/`flux-system` are always blocked. Spec-mutating actions also refuse Flux/Helm-managed workloads (GitOps guard — the source of truth would revert them); `rollout_restart` stays allowed | — |
| `MAX_SCALE_DELTA` | Max replica change per `k8s_scale` action (scale-to-zero only with `quarantine: true`) | `5` |
| `MIN_ORPHAN_AGE_DAYS` | Minimum age before `k8s_delete_orphan` accepts an object. A value under 14 is warned about on every boot | `14` |

## Upstreams

| Variable | Description | Default |
|----------|-------------|---------|
| `K8S_AUTH_MODE` | `kubeconfig` or `incluster` | `kubeconfig` |
| `K8S_KUBECONFIG_PATH` | Path to kubeconfig | `~/.kube/config` |
| `PROMETHEUS_URL` | Prometheus base URL | `http://localhost:9090` |
| `PROMETHEUS_USERNAME` | Basic auth (optional) | — |
| `PROMETHEUS_PASSWORD` | Basic auth (optional) | — |
| `ALERTMANAGER_URL` | Alertmanager base URL — the source of truth for what is firing (every evaluator routes here, and only it knows about silences/inhibition) | `http://localhost:9093` |
| `ALERTMANAGER_USERNAME` | Basic auth (optional) | — |
| `ALERTMANAGER_PASSWORD` | Basic auth (optional) | — |
| `LOKI_URL` | Loki base URL | `http://localhost:3100` |
| `LOKI_USERNAME` | Basic auth (optional) | — |
| `LOKI_PASSWORD` | Basic auth (optional) | — |
| `TRACING_BACKEND` | Trace query backend: `tempo` or `jaeger` | `tempo` |
| `TRACING_URL` | Tracing backend base URL (tracing tools error until set) | — |
| `TRACING_USERNAME` | Basic auth (optional) | — |
| `TRACING_PASSWORD` | Basic auth (optional) | — |

## Limits and logs

| Variable | Description | Default |
|----------|-------------|---------|
| `UPSTREAM_TIMEOUT_SECONDS` | Max wait on any upstream (K8s/Prometheus/Alertmanager/Loki/tracing) before failing the tool | `30` |
| `K8S_LIST_LIMIT` | Cap on items returned by namespaced list tools (pods/events/configmaps/secrets). Deliberately **not** applied to `k8s_cluster_health`, which pages through everything | `100` |
| `LOG_LEVEL` | `error\|warn\|info\|http\|debug` | `debug` (dev), `info` (prod) |
