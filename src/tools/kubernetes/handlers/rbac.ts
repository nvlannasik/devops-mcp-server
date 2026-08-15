import { z } from "zod";
import { getApi, k8s } from "../client.js";
import { withUpstream } from "../../../utils/errors/index.js";
import { NS } from "../schemas.js";

// "What can this ServiceAccount do?" — for `forbidden` / permission-denied RCA. Traces the SA
// through its Role/ClusterRole bindings to the actual rules. Answers e.g. why the agent's own
// SA couldn't get a Flux CRD. No SubjectAccessReview (that needs a privileged verb) — just reads
// the bindings + roles the SA's own token can already see.

type Subject = { kind?: string; name?: string; namespace?: string };

// exported for unit tests: does a binding's subject list include this SA?
export function subjectMatchesSa(subjects: Subject[] | undefined, sa: string, namespace: string): boolean {
  return (subjects ?? []).some((s) => s.kind === "ServiceAccount" && s.name === sa && (s.namespace ?? namespace) === namespace);
}

export const getSaPermissions = (input: unknown) => {
  const { namespace, serviceaccount } = NS.extend({ serviceaccount: z.string().min(1) }).parse(input);
  return withUpstream("kubernetes", `Failed to get permissions for serviceaccount ${namespace}/${serviceaccount}`, async () => {
    const rbac = getApi(k8s.RbacAuthorizationV1Api);
    const [roleBindings, clusterRoleBindings] = await Promise.all([
      rbac.listNamespacedRoleBinding({ namespace }),
      rbac.listClusterRoleBinding(),
    ]);

    const bound = [
      ...roleBindings.items.filter((rb) => subjectMatchesSa(rb.subjects, serviceaccount, namespace)).map((rb) => ({ binding: rb.metadata!.name!, roleKind: rb.roleRef.kind, roleName: rb.roleRef.name })),
      ...clusterRoleBindings.items.filter((crb) => subjectMatchesSa(crb.subjects, serviceaccount, namespace)).map((crb) => ({ binding: crb.metadata!.name!, roleKind: crb.roleRef.kind, roleName: crb.roleRef.name })),
    ];

    // resolve each bound (Cluster)Role to its rules (best-effort — a missing role isn't fatal)
    const rules = await Promise.all(
      bound.map(async (b) => {
        try {
          const role = b.roleKind === "ClusterRole" ? await rbac.readClusterRole({ name: b.roleName }) : await rbac.readNamespacedRole({ name: b.roleName, namespace });
          return { role: `${b.roleKind}/${b.roleName}`, via: b.binding, rules: role.rules?.map((r) => ({ apiGroups: r.apiGroups, resources: r.resources, verbs: r.verbs })) };
        } catch {
          return { role: `${b.roleKind}/${b.roleName}`, via: b.binding, rules: "(could not read role)" };
        }
      })
    );

    return {
      serviceAccount: `${namespace}/${serviceaccount}`,
      boundRoles: bound.map((b) => `${b.roleKind}/${b.roleName}`),
      rules,
    };
  });
};
