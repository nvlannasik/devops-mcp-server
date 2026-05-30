import "dotenv/config";

type Env = "dev" | "staging" | "prod";

interface Config {
  kubernetes: {
    authMode: string;
    kubeconfigPath?: string;
    apiServer?: string;
    token?: string;
    caCertPath?: string;
  };
  prometheus: {
    url: string;
    username?: string;
    password?: string;
  };
  loki: {
    url: string;
    username?: string;
    password?: string;
  };
}

const env = (process.env.NODE_ENV || "dev") as Env;

const configs: Record<Env, Config> = {
  dev: {
    kubernetes: {
      authMode: process.env.K8S_AUTH_MODE || "kubeconfig",
      kubeconfigPath: process.env.K8S_KUBECONFIG_PATH || "~/.kube/config",
      apiServer: process.env.K8S_API_SERVER,
      token: process.env.K8S_TOKEN,
      caCertPath: process.env.K8S_CA_CERT_PATH,
    },
    prometheus: {
      url: process.env.PROMETHEUS_URL || "http://localhost:9090",
      username: process.env.PROMETHEUS_USERNAME,
      password: process.env.PROMETHEUS_PASSWORD,
    },
    loki: {
      url: process.env.LOKI_URL || "http://localhost:3100",
      username: process.env.LOKI_USERNAME,
      password: process.env.LOKI_PASSWORD,
    },
  },
  staging: {
    kubernetes: {
      authMode: process.env.K8S_AUTH_MODE || "incluster",
      kubeconfigPath: process.env.K8S_KUBECONFIG_PATH,
      apiServer: process.env.K8S_API_SERVER,
      token: process.env.K8S_TOKEN,
      caCertPath: process.env.K8S_CA_CERT_PATH,
    },
    prometheus: {
      url: process.env.PROMETHEUS_URL!,
      username: process.env.PROMETHEUS_USERNAME,
      password: process.env.PROMETHEUS_PASSWORD,
    },
    loki: {
      url: process.env.LOKI_URL!,
      username: process.env.LOKI_USERNAME,
      password: process.env.LOKI_PASSWORD,
    },
  },
  prod: {
    kubernetes: {
      authMode: process.env.K8S_AUTH_MODE || "incluster",
      kubeconfigPath: process.env.K8S_KUBECONFIG_PATH,
      apiServer: process.env.K8S_API_SERVER,
      token: process.env.K8S_TOKEN,
      caCertPath: process.env.K8S_CA_CERT_PATH,
    },
    prometheus: {
      url: process.env.PROMETHEUS_URL!,
      username: process.env.PROMETHEUS_USERNAME,
      password: process.env.PROMETHEUS_PASSWORD,
    },
    loki: {
      url: process.env.LOKI_URL!,
      username: process.env.LOKI_USERNAME,
      password: process.env.LOKI_PASSWORD,
    },
  },
};

const validEnvs = Object.keys(configs) as Env[];
if (!validEnvs.includes(env)) {
  throw new Error(`Invalid NODE_ENV "${env}". Must be one of: ${validEnvs.join(", ")}`);
}

export default configs[env];
