import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { jsonSchemaToZod } from "./index.js";

// The bug this guards: an array property fell through to z.string(), so the SDK — which
// derives the advertised tool schema from THIS shape, not from tool.inputSchema — published
// alertmanager_get_alerts' `filter` as a string. The model sent one, and the handler's own
// z.array() rejected the call.
const shapeOf = (prop: Record<string, unknown>) =>
  z.object(jsonSchemaToZod({ properties: { filter: prop } }));

test("array property stays an array, not a string", () => {
  const s = shapeOf({ type: "array", items: { type: "string" } });
  assert.deepEqual(s.parse({ filter: ['severity="critical"'] }).filter, ['severity="critical"']);
  assert.throws(() => s.parse({ filter: [1] }));
});

test("a string where an array is expected is absorbed, and reaches the handler as an array", () => {
  const s = shapeOf({ type: "array", items: { type: "string" } });
  // "" is what a small model sends for "no filter" — must mean no filter, not [""]
  assert.deepEqual(s.parse({ filter: "" }).filter, []);
  assert.deepEqual(s.parse({ filter: 'namespace="payments"' }).filter, ['namespace="payments"']);
  // the handler re-validates its own input, so the coerced value has to satisfy it too
  assert.doesNotThrow(() => z.object({ filter: z.array(z.string()).optional() }).parse(s.parse({ filter: "" })));
});

test("scalar properties are unchanged", () => {
  assert.equal(shapeOf({ type: "number" }).parse({ filter: 5 }).filter, 5);
  assert.equal(shapeOf({ type: "boolean" }).parse({ filter: true }).filter, true);
  assert.equal(shapeOf({ type: "string" }).parse({ filter: "x" }).filter, "x");
  assert.equal(shapeOf({ enum: ["a", "b"] }).parse({ filter: "b" }).filter, "b");
});

test("optional unless required", () => {
  assert.deepEqual(shapeOf({ type: "array", items: { type: "string" } }).parse({}), {});
  const required = z.object(
    jsonSchemaToZod({ properties: { filter: { type: "array", items: { type: "string" } } }, required: ["filter"] })
  );
  assert.throws(() => required.parse({}));
});
