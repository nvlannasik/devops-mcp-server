import { createHttpClient } from "../../utils/http/index.js";
import { ValidationError } from "../../utils/errors/index.js";
import config from "../../config/index.js";
import { tempoAdapter, jaegerAdapter, type TracingAdapter } from "./adapters.js";

let _adapter: TracingAdapter | null = null;

export function getAdapter(): TracingAdapter {
  if (_adapter) return _adapter;
  const { backend, url, username, password } = config.tracing;
  if (!url) {
    throw new ValidationError("Tracing not configured — set TRACING_URL (and TRACING_BACKEND=tempo|jaeger)");
  }
  const http = createHttpClient(url, username ? { username, password } : undefined, config.upstreamTimeoutMs);
  if (backend === "tempo") _adapter = tempoAdapter(http);
  else if (backend === "jaeger") _adapter = jaegerAdapter(http);
  else throw new ValidationError(`Unknown TRACING_BACKEND "${backend}" — use tempo or jaeger`);
  return _adapter;
}
