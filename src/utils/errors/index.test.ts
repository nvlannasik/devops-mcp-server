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
