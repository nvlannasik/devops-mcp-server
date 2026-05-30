import { z } from "zod";

export const NS = z.object({ namespace: z.string().default("default") });
export const NSLabel = NS.extend({ label_selector: z.string().optional() });
export const NSField = NS.extend({ field_selector: z.string().optional() });
