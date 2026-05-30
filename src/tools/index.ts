import kubernetes from "./kubernetes/index.js";
import prometheus from "./prometheus/index.js";
import loki from "./loki/index.js";
import type { Tool } from "./types.js";

const allTools: Tool[] = [...kubernetes, ...prometheus, ...loki];

export default allTools;
