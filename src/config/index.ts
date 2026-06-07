import "dotenv/config";

const config = {
  kubernetes: {
    authMode: process.env.K8S_AUTH_MODE ?? "kubeconfig",
    kubeconfigPath: process.env.K8S_KUBECONFIG_PATH ?? "~/.kube/config",
    apiServer: process.env.K8S_API_SERVER,
    token: process.env.K8S_TOKEN,
    caCertPath: process.env.K8S_CA_CERT_PATH,
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
};

export default config;
