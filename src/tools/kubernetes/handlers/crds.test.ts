import { test } from "node:test";
import assert from "node:assert/strict";
import { compactCustomResources } from "./crds.js";

test("compact CR rows carry the Ready condition and cap its message", () => {
  const rows = compactCustomResources([
    {
      metadata: { name: "devops-ai-agent", namespace: "devops-tools", creationTimestamp: "2026-07-10T10:00:00Z" },
      status: {
        conditions: [
          { type: "Released", status: "True", message: "ok" },
          { type: "Ready", status: "False", message: "M".repeat(300) },
        ],
      },
    },
    { metadata: { name: "bare" } }, // no status at all
  ]);
  assert.equal(rows[0].ready, "False");
  assert.equal(rows[0].message!.length, 200);
  assert.deepEqual(rows[1], { name: "bare", namespace: undefined, ready: undefined, message: undefined, age: undefined });
});
