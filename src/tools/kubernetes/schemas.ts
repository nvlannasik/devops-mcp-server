import { z } from "zod";

export const NS = z.object({ namespace: z.string().default("default") });
export const NSLabel = NS.extend({ label_selector: z.string().optional() });
export const NSField = NS.extend({ field_selector: z.string().optional() });

/**
 * An optional parameter a model fills with `""` instead of omitting. Observed live:
 * `k8s_find_unused_resources` was called with `{"namespace":""}` meaning "the whole cluster",
 * and the DNS-1123 regex rejected it with a ZodError. The model recovered by retrying without
 * the field, so the only visible cost was a wasted round — but the same input reaches
 * `k8s_cluster_health`, which the system prompt tells the model to call FIRST on every
 * cluster-wide question, and a weak model that does not work out the fix loops on it.
 *
 * `""` is how a model spells "not applicable" in a required-shaped slot. Treating it as absent
 * is the reading that matches intent; rejecting it is technically right and practically a bug.
 * Wraps rather than replaces the inner schema, so a real value is still validated exactly as
 * before — `"Not-A-Namespace"` is still an error.
 */
export const blankToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  // The return type is stated because z.preprocess widens its input to `unknown`, and that
  // widening propagates: without it every OTHER field of the enclosing z.object() infers as
  // unknown too, and the handler stops type-checking its own parsed values.
  z.preprocess((v) => (v === "" ? undefined : v), schema) as z.ZodType<z.output<T>, z.ZodTypeDef, unknown>;
