import * as k8s from "@kubernetes/client-node";
import config from "../../config/index.js";

let _kc: k8s.KubeConfig | null = null;

function getKubeConfig(): k8s.KubeConfig {
  if (_kc) return _kc;
  _kc = new k8s.KubeConfig();
  if (config.kubernetes.authMode === "incluster") {
    _kc.loadFromCluster();
  } else {
    const path = (config.kubernetes.kubeconfigPath ?? "~/.kube/config").replace("~", process.env.HOME ?? "");
    _kc.loadFromFile(path);
  }
  return _kc;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const getApi = <T>(ApiClass: new (...args: any[]) => T): T =>
  getKubeConfig().makeApiClient(ApiClass);

export { k8s };
