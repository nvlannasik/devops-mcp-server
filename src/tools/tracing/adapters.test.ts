import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOtlp, jaegerAdapter, tempoAdapter } from "./adapters.js";

test("normalizeOtlp flattens batches, derives service/duration/error", () => {
  const otlp = {
    batches: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "payment" } }] },
        scopeSpans: [
          {
            spans: [
              {
                spanId: "a1",
                parentSpanId: "",
                name: "POST /charge",
                startTimeUnixNano: "1000000000", // 1s
                endTimeUnixNano: "1500000000", // 1.5s -> 500ms
                status: { code: 2 }, // ERROR
              },
            ],
          },
        ],
      },
    ],
  };
  const t = normalizeOtlp("trace-1", otlp);
  assert.equal(t.spanCount, 1);
  const s = t.spans[0];
  assert.equal(s.service, "payment");
  assert.equal(s.name, "POST /charge");
  assert.equal(s.durationMs, 500);
  assert.equal(s.parentSpanId, undefined); // empty string -> undefined (root)
  assert.equal(s.error, true);
});

test("normalizeOtlp accepts the resourceSpans alias and STATUS_CODE_ERROR string", () => {
  const t = normalizeOtlp("t", {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          { spans: [{ spanId: "x", name: "q", startTimeUnixNano: "0", endTimeUnixNano: "0", status: { code: "STATUS_CODE_ERROR" } }] },
        ],
      },
    ],
  });
  assert.equal(t.spans[0].service, "unknown");
  assert.equal(t.spans[0].error, true);
});

test("jaeger getTrace maps spans, parent via CHILD_OF, error tags, microsecond duration", async () => {
  const fakeHttp = {
    get: async () => ({
      data: {
        data: [
          {
            traceID: "tr",
            processes: { p1: { serviceName: "api" }, p2: { serviceName: "db" } },
            spans: [
              { spanID: "root", operationName: "GET /x", processID: "p1", duration: 2000, startTime: 1_000_000, references: [], tags: [] },
              {
                spanID: "child",
                operationName: "SELECT",
                processID: "p2",
                duration: 1500,
                startTime: 1_100_000,
                references: [{ refType: "CHILD_OF", spanID: "root" }],
                tags: [{ key: "error", value: true }],
              },
            ],
          },
        ],
      },
    }),
  };
  const t = await jaegerAdapter(fakeHttp as any).getTrace("tr");
  assert.equal(t.spanCount, 2);
  const child = t.spans.find((s) => s.spanId === "child")!;
  assert.equal(child.parentSpanId, "root");
  assert.equal(child.service, "db");
  assert.equal(child.durationMs, 1.5); // 1500us
  assert.equal(child.error, true);
  assert.equal(t.spans.find((s) => s.spanId === "root")!.parentSpanId, undefined);
});

test("jaeger search requires a service", async () => {
  await assert.rejects(
    () => jaegerAdapter({} as any).searchTraces({ startSec: 0, endSec: 1, limit: 10 }),
    /requires a 'service'/
  );
});

test("tempo searchTraces builds TraceQL and maps summaries", async () => {
  let captured: any;
  const fakeHttp = {
    get: async (_url: string, opts: any) => {
      captured = opts.params;
      return { data: { traces: [{ traceID: "z", rootServiceName: "api", rootTraceName: "GET /", durationMs: 42, startTimeUnixNano: "1000000000" }] } };
    },
  };
  const out = await tempoAdapter(fakeHttp as any).searchTraces({ service: "api", minDurationMs: 100, startSec: 5, endSec: 9, limit: 3 });
  assert.equal(captured.q, '{resource.service.name="api" && duration>100ms}');
  assert.equal(captured.start, 5);
  assert.equal(out[0].traceId, "z");
  assert.equal(out[0].durationMs, 42);
});
