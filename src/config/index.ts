import "dotenv/config";

const config = {
  // max time (seconds) to wait on any upstream (Prometheus/Loki HTTP, K8s API) before failing the tool
  upstreamTimeoutMs: parseInt(process.env.UPSTREAM_TIMEOUT_SECONDS ?? "30") * 1000,
  // Shared bearer token required on /mcp when set. Unset = open (dev/stdio); a warning is logged in http mode.
  auth: {
    token: process.env.MCP_AUTH_TOKEN,
  },
  // Guarded Remediation (docs in devops-ai-agent/docs/DESIGN_guarded_remediation.md).
  // Write tools are NOT REGISTERED unless enabled — the agent caches listTools() at
  // startup, and a listed-but-refusing tool makes the LLM loop on it.
  writeTools: {
    enabled: process.env.MCP_ENABLE_WRITE_TOOLS === "true",
    // empty = every namespace blocked (explicit opt-in; enforced server-side, not in the agent)
    allowedNamespaces: (process.env.ALLOWED_REMEDIATION_NAMESPACES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // k8s_scale blast-radius limit: max |new - current| replicas per action
    maxScaleDelta: parseInt(process.env.MAX_SCALE_DELTA ?? "5"),
  },
  // cap on items returned by namespaced list tools, so a huge namespace can't produce
  // a response that gets truncated to garbage downstream
  k8sListLimit: parseInt(process.env.K8S_LIST_LIMIT ?? "100"),
  // Only these two are read: client.ts either loads from the cluster (incluster) or from a
  // kubeconfig file. There is no hand-rolled apiServer/token/caCert path — the client-node
  // library builds the connection from one of those two sources, never from loose env vars.
  kubernetes: {
    authMode: process.env.K8S_AUTH_MODE ?? "kubeconfig",
    kubeconfigPath: process.env.K8S_KUBECONFIG_PATH ?? "~/.kube/config",
  },
  prometheus: {
    url: process.env.PROMETHEUS_URL ?? "http://localhost:9090",
    username: process.env.PROMETHEUS_USERNAME,
    password: process.env.PROMETHEUS_PASSWORD,
  },
  loki: {
    url: process.env.LOKI_URL ?? "http://localhost:3100",
    username: process.env.LOKI_USERNAME,
    password: process.env.LOKI_PASSWORD,
  },
  tracing: {
    // Query backend: tempo | jaeger. (OTel Collector is ingest-only — point this at
    // whatever store the collector exports to.) Tools error clearly if url is unset.
    backend: process.env.TRACING_BACKEND ?? "tempo",
    url: process.env.TRACING_URL ?? "",
    username: process.env.TRACING_USERNAME,
    password: process.env.TRACING_PASSWORD,
  },
};

export default config;
