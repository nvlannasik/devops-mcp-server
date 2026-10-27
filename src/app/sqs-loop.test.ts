import { test } from "node:test";
import assert from "node:assert/strict";
import { pollRequests } from "./sqs-loop.js";

test("one receive: each message handled with its body and receipt handle, heartbeat touched, abort stops the loop", async () => {
  const ac = new AbortController();
  const handled: Array<[string | undefined, string]> = [];
  let beats = 0;
  let receives = 0;
  const receiveInputs: any[] = [];
  const sqs = {
    send: async (cmd: any) => {
      if (cmd.constructor.name !== "ReceiveMessageCommand") throw new Error(`unexpected ${cmd.constructor.name}`);
      receives++;
      receiveInputs.push(cmd.input);
      if (receives === 1) return { Messages: [{ Body: '{"a":1}', ReceiptHandle: "rh-1" }, { Body: '{"b":2}', ReceiptHandle: "rh-2" }] };
      ac.abort();
      return { Messages: [] };
    },
  };
  await pollRequests(ac.signal, {
    sqs, requestUrl: "https://q/req", concurrency: 4, pollWaitSeconds: 1, visibilitySeconds: 65,
    heartbeat: async () => { beats++; },
    handle: async (body, rh) => { handled.push([body, rh]); },
  });
  assert.deepEqual(handled, [['{"a":1}', "rh-1"], ['{"b":2}', "rh-2"]]);
  assert.ok(beats >= 1);
  assert.equal(receiveInputs[0].VisibilityTimeout, 65, "a slow read is never redelivered mid-run");
  assert.equal(receiveInputs[0].QueueUrl, "https://q/req");
});

test("a handler that throws does not stop the loop", async () => {
  const ac = new AbortController();
  let receives = 0;
  const sqs = {
    send: async () => {
      receives++;
      if (receives === 1) return { Messages: [{ Body: "x", ReceiptHandle: "rh" }] };
      ac.abort();
      return { Messages: [] };
    },
  };
  await pollRequests(ac.signal, {
    sqs, requestUrl: "u", concurrency: 1, pollWaitSeconds: 1, visibilitySeconds: 65,
    heartbeat: async () => {},
    handle: async () => { throw new Error("handler blew up"); },
  });
  assert.ok(receives >= 2);
});

test("the receive asks for the trace attributes, and each message is handled inside the sender's trace", async () => {
  const { context, propagation, trace } = await import("@opentelemetry/api");
  const { W3CTraceContextPropagator } = await import("@opentelemetry/core");
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks");
  const { TracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await import("@opentelemetry/sdk-trace");
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: new InMemorySpanExporter() })] }));
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
  const ac = new AbortController();
  let receives = 0;
  const receiveInputs: any[] = [];
  const seen: Array<string | undefined> = [];
  const { isTracingSuppressed } = await import("@opentelemetry/core");
  const pollSuppressed: boolean[] = [];
  const sqs = {
    send: async (cmd: any) => {
      pollSuppressed.push(isTracingSuppressed(context.active()) && !trace.getActiveSpan());
      receives++;
      receiveInputs.push(cmd.input);
      if (receives === 1) {
        return { Messages: [{ Body: "{}", ReceiptHandle: "rh", MessageAttributes: { traceparent: { DataType: "String", StringValue: `00-${TRACE}-00f067aa0ba902b7-01` } } }] };
      }
      ac.abort();
      return { Messages: [] };
    },
  };
  await pollRequests(ac.signal, {
    sqs, requestUrl: "u", concurrency: 1, pollWaitSeconds: 1, visibilitySeconds: 65,
    heartbeat: async () => {},
    handle: async () => { seen.push(trace.getActiveSpan()?.spanContext().traceId); },
  });
  assert.deepEqual(receiveInputs[0].MessageAttributeNames, ["traceparent", "tracestate"]);
  assert.deepEqual(seen, [TRACE]);
  assert.ok(pollSuppressed.length > 0 && pollSuppressed.every(Boolean), "the receive itself belongs to no trace");
});
