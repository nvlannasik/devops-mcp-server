import kubernetes from "./kubernetes/index.js";
import prometheus from "./prometheus/index.js";
import loki from "./loki/index.js";
import tracing from "./tracing/index.js";
import type { Tool } from "./types.js";

const allTools: Tool[] = [...kubernetes, ...prometheus, ...loki, ...tracing];

export default allTools;
