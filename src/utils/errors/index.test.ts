import { test } from "node:test";
import assert from "node:assert/strict";
import { conciseCause } from "./index.js";

// Shape of @kubernetes/client-node ApiException: huge .message dump + raw JSON .body
const k8sNotFound = Object.assign(
  new Error(
    'HTTP-Code: 404\nMessage: Unknown API Status Code!\nBody: "{\\"kind\\":\\"Status\\"}"\nHeaders: {"audit-id":"x"}'
  ),
  { body: '{"kind":"Status","status":"Failure","message":"pods \\"api-123\\" not found","code":404}' }
);

test("extracts the K8s Status message from a string body", () => {
  assert.equal(conciseCause(k8sNotFound), 'pods "api-123" not found');
});

test("extracts message from an already-parsed object body", () => {
  assert.equal(conciseCause({ body: { message: "deployments.apps \"x\" is forbidden" } }), 'deployments.apps "x" is forbidden');
});

test("falls back to trimming the HTTP dump off the message", () => {
  const err = new Error('HTTP-Code: 500\nMessage: boom\nBody: "..."\nHeaders: {"a":"b"}');
  assert.equal(conciseCause(err), "HTTP-Code: 500 Message: boom");
});

test("plain errors pass through unchanged", () => {
  assert.equal(conciseCause(new Error("getaddrinfo ENOTFOUND prometheus")), "getaddrinfo ENOTFOUND prometheus");
});

// axios hides the upstream's explanation in response.data — err.message is only
// "Request failed with status code 400", which taught the model nothing and made it
// retry the same broken query
test("surfaces the Prometheus error body instead of the bare status code", () => {
  const err = Object.assign(new Error("Request failed with status code 400"), {
    response: { status: 400, data: { status: "error", errorType: "bad_data", error: '1:9: parse error: unexpected ")"' } },
  });
  assert.equal(conciseCause(err), '400 1:9: parse error: unexpected ")"');
});

test("surfaces a Loki-style message body and a plain-text body", () => {
  const loki = Object.assign(new Error("Request failed with status code 400"), {
    response: { status: 400, data: { status: "error", message: "parse error at line 1: syntax error" } },
  });
  assert.equal(conciseCause(loki), "400 parse error at line 1: syntax error");

  const text = Object.assign(new Error("Request failed with status code 502"), {
    response: { status: 502, data: "upstream connect error" },
  });
  assert.equal(conciseCause(text), "502 upstream connect error");
});

test("a connection error with no response still falls back to the message", () => {
  const err = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:9090"), { code: "ECONNREFUSED" });
  assert.equal(conciseCause(err), "connect ECONNREFUSED 10.0.0.1:9090");
});
