import { type AxiosInstance } from "axios";
import { ValidationError } from "../../utils/errors/index.js";

// Backend-agnostic shapes. Tempo (OTLP) and Jaeger return wildly different JSON;
// we normalize both to this compact form so one prompt/playbook works for either,
// and so a big trace stays token-cheap (the agent truncates tool results at 8000 chars).
export interface TraceSummary {
  traceId: string;
  rootService: string;
  rootName: string;
  durationMs: number;
  startTime: string; // ISO 8601
}

export interface NormalizedSpan {
  spanId: string;
  parentSpanId?: string;
  service: string;
  name: string;
  durationMs: number;
  startTime: string; // ISO 8601
  error: boolean;
}

export interface NormalizedTrace {
  traceId: string;
  durationMs: number;
  spanCount: number;
  spans: NormalizedSpan[];
}

export interface SearchParams {
  service?: string;
  minDurationMs?: number;
  startSec: number;
  endSec: number;
  limit: number;
}

export interface TracingAdapter {
  searchTraces(p: SearchParams): Promise<TraceSummary[]>;
  getTrace(traceId: string): Promise<NormalizedTrace>;
  listServices(): Promise<string[]>;
}

const nanoToIso = (ns: string | number) => new Date(Number(ns) / 1e6).toISOString();
const microToIso = (us: string | number) => new Date(Number(us) / 1e3).toISOString();

// ---------- Tempo (Grafana) — TraceQL search + OTLP trace ----------

export function tempoAdapter(http: AxiosInstance): TracingAdapter {
  return {
    async searchTraces({ service, minDurationMs, startSec, endSec, limit }) {
      const filters: string[] = [];
      if (service) filters.push(`resource.service.name="${service}"`);
      if (minDurationMs) filters.push(`duration>${minDurationMs}ms`);
      const q = `{${filters.join(" && ")}}`; // "{}" = all spans
      const res = await http.get("/api/search", { params: { q, start: startSec, end: endSec, limit } });
      return (res.data.traces ?? []).map((t: any) => ({
        traceId: t.traceID,
        rootService: t.rootServiceName ?? "",
        rootName: t.rootTraceName ?? "",
        durationMs: t.durationMs ?? 0,
        startTime: t.startTimeUnixNano ? nanoToIso(t.startTimeUnixNano) : "",
      }));
    },
    async getTrace(traceId) {
      const res = await http.get(`/api/traces/${traceId}`);
      return normalizeOtlp(traceId, res.data);
    },
    async listServices() {
      const res = await http.get("/api/search/tag/service.name/values");
      return res.data.tagValues ?? [];
    },
  };
}

// OTLP/JSON: trace_id/span_id are hex strings, *UnixNano are stringified int64.
export function normalizeOtlp(traceId: string, data: any): NormalizedTrace {
  const batches = data.batches ?? data.resourceSpans ?? [];
  const spans: NormalizedSpan[] = [];
  for (const b of batches) {
    const service = attr(b.resource?.attributes ?? [], "service.name") ?? "unknown";
    const scopes = b.scopeSpans ?? b.instrumentationLibrarySpans ?? [];
    for (const scope of scopes) {
      for (const s of scope.spans ?? []) {
        const start = Number(s.startTimeUnixNano);
        const end = Number(s.endTimeUnixNano);
        const code = s.status?.code;
        spans.push({
          spanId: s.spanId,
          parentSpanId: s.parentSpanId || undefined,
          service,
          name: s.name,
          durationMs: (end - start) / 1e6,
          startTime: nanoToIso(s.startTimeUnixNano),
          error: code === 2 || code === "STATUS_CODE_ERROR",
        });
      }
    }
  }
  return summarize(traceId, spans);
}

function attr(attrs: any[], key: string): string | undefined {
  const v = attrs.find((x) => x.key === key)?.value;
  return v?.stringValue ?? (v?.intValue != null ? String(v.intValue) : undefined);
}

// ---------- Jaeger — Query API ----------

export function jaegerAdapter(http: AxiosInstance): TracingAdapter {
  return {
    async searchTraces({ service, minDurationMs, startSec, endSec, limit }) {
      if (!service) throw new ValidationError("Jaeger trace search requires a 'service' name");
      const params: Record<string, unknown> = {
        service,
        start: startSec * 1e6, // Jaeger uses microseconds
        end: endSec * 1e6,
        limit,
      };
      if (minDurationMs) params.minDuration = `${minDurationMs}ms`;
      const res = await http.get("/api/traces", { params });
      return (res.data.data ?? []).map((t: any) => {
        const root = rootSpan(t.spans);
        return {
          traceId: t.traceID,
          rootService: t.processes?.[root?.processID]?.serviceName ?? "",
          rootName: root?.operationName ?? "",
          durationMs: (root?.duration ?? 0) / 1e3,
          startTime: root ? microToIso(root.startTime) : "",
        };
      });
    },
    async getTrace(traceId) {
      const res = await http.get(`/api/traces/${traceId}`);
      const t = (res.data.data ?? [])[0];
      if (!t) return { traceId, durationMs: 0, spanCount: 0, spans: [] };
      const spans: NormalizedSpan[] = (t.spans ?? []).map((s: any) => ({
        spanId: s.spanID,
        parentSpanId: s.references?.find((r: any) => r.refType === "CHILD_OF")?.spanID || undefined,
        service: t.processes?.[s.processID]?.serviceName ?? "unknown",
        name: s.operationName,
        durationMs: s.duration / 1e3,
        startTime: microToIso(s.startTime),
        error: jaegerError(s.tags),
      }));
      return summarize(traceId, spans);
    },
    async listServices() {
      const res = await http.get("/api/services");
      return res.data.data ?? [];
    },
  };
}

const rootSpan = (spans: any[]) =>
  spans?.find((s) => !s.references?.some((r: any) => r.refType === "CHILD_OF")) ?? spans?.[0];

const jaegerError = (tags: any[]) =>
  (tags ?? []).some(
    (t) =>
      (t.key === "error" && (t.value === true || t.value === "true")) ||
      (t.key === "otel.status_code" && t.value === "ERROR") ||
      (t.key === "http.status_code" && Number(t.value) >= 500)
  );

// Trace duration = root span duration; fall back to wall-clock span of the trace.
function summarize(traceId: string, spans: NormalizedSpan[]): NormalizedTrace {
  const durationMs = spans.length
    ? Math.max(...spans.map((s) => new Date(s.startTime).getTime() + s.durationMs)) -
      Math.min(...spans.map((s) => new Date(s.startTime).getTime()))
    : 0;
  return { traceId, durationMs, spanCount: spans.length, spans };
}
