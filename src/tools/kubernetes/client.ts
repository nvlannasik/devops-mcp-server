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
export const getApi = <T extends k8s.ApiType>(ApiClass: new (...args: any[]) => T): T =>
  getKubeConfig().makeApiClient(ApiClass);

export { k8s };

// Follow `_continue` to the end of a list. Cluster-wide scans (capacity/) build a REFERENCE
// index from these results — a truncated page there does not mean "fewer findings", it means a
// live ConfigMap gets reported as unused because the pod holding it fell off the last page.
// Same reasoning as k8s_cluster_health: read everything, or say the scan was incomplete.
const MAX_ITEMS_SCANNED = 10000;
const PAGE_LIMIT = 500;

export interface Page<T> {
  items: T[];
  metadata?: { _continue?: string };
}

export async function listAll<T>(
  fetchPage: (opts: { limit: number; _continue?: string }) => Promise<Page<T>>
): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  let cont: string | undefined;
  do {
    const page = await fetchPage({ limit: PAGE_LIMIT, _continue: cont });
    items.push(...page.items);
    cont = page.metadata?._continue || undefined;
    if (cont && items.length >= MAX_ITEMS_SCANNED) return { items, complete: false };
  } while (cont);
  return { items, complete: true };
}
