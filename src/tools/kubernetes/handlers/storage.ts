import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NS } from "../schemas.js";

export const listPVCs = (input: unknown) => {
  const { namespace } = NS.parse(input);
  return withUpstream("kubernetes", "Failed to list PVCs", async () => {
    const res = await getApi(k8s.CoreV1Api).listNamespacedPersistentVolumeClaim({ namespace });
    return res.items.map((p) => ({
      name: p.metadata!.name,
      namespace: p.metadata!.namespace,
      status: p.status!.phase, // Pending = no volume bound yet (check StorageClass provisioner)
      capacity: p.status!.capacity?.storage,
      storageClass: p.spec!.storageClassName,
      accessModes: p.spec!.accessModes,
      age: p.metadata!.creationTimestamp,
    }));
  });
};

// Cluster-scoped: PV phase (Bound/Available/Released/Failed) + which claim it's bound to.
export const listPersistentVolumes = () =>
  withUpstream("kubernetes", "Failed to list PersistentVolumes", async () => {
    const res = await getApi(k8s.CoreV1Api).listPersistentVolume();
    return res.items.map((pv) => ({
      name: pv.metadata!.name,
      status: pv.status!.phase, // Failed/Released = trouble; Available = unclaimed
      capacity: pv.spec!.capacity?.storage,
      storageClass: pv.spec!.storageClassName,
      reclaimPolicy: pv.spec!.persistentVolumeReclaimPolicy,
      claim: pv.spec!.claimRef ? `${pv.spec!.claimRef.namespace}/${pv.spec!.claimRef.name}` : null,
      accessModes: pv.spec!.accessModes,
      age: pv.metadata!.creationTimestamp,
    }));
  });

// StorageClasses: the provisioner + default flag — a PVC stuck Pending often means no default
// class or a broken provisioner.
export const listStorageClasses = () =>
  withUpstream("kubernetes", "Failed to list StorageClasses", async () => {
    const res = await getApi(k8s.StorageV1Api).listStorageClass();
    return res.items.map((sc) => ({
      name: sc.metadata!.name,
      provisioner: sc.provisioner,
      default: sc.metadata!.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true",
      reclaimPolicy: sc.reclaimPolicy,
      volumeBindingMode: sc.volumeBindingMode,
    }));
  });
