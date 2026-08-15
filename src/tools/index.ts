import kubernetes from "./kubernetes/index.js";
import prometheus from "./prometheus/index.js";
import loki from "./loki/index.js";
import tracing from "./tracing/index.js";
import writeTools from "./kubernetes/write.js";
import config from "../config/index.js";
import type { Tool } from "./types.js";

// Write tools join the list only when explicitly enabled — read-only deployments never
// even expose them (conditional REGISTRATION; see kubernetes/write.ts for why).
const allTools: Tool[] = [
  ...kubernetes,
  ...prometheus,
  ...loki,
  ...tracing,
  ...(config.writeTools.enabled ? writeTools : []),
];

export default allTools;
