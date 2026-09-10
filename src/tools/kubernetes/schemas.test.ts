import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { blankToUndefined } from "./schemas.js";

// Live regression 2026-09-10: k8s_find_unused_resources was called with {"namespace":""} —
// the model's way of saying "the whole cluster" — and the DNS-1123 regex rejected it. The same
// input reaches k8s_cluster_health, which the system prompt tells the model to call FIRST.
const NS_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const Optional = z.object({ namespace: blankToUndefined(z.string().regex(NS_RE).optional()) });
const Defaulted = z.object({ window: blankToUndefined(z.string().regex(/^\d+[mhd]$/).default("24h")) });

test('an empty string reads as absent, not as an invalid value', () => {
  // The value, not the object shape: zod leaves the key present as `undefined`, which is what
  // every `if (namespace)` downstream already treats as omitted.
  assert.equal(Optional.parse({ namespace: "" }).namespace, undefined);
  assert.equal(Optional.parse({}).namespace, undefined);
});

test('an empty string falls through to the default when there is one', () => {
  assert.equal(Defaulted.parse({ window: "" }).window, "24h");
  assert.equal(Defaulted.parse({ window: "7d" }).window, "7d");
});

test("a real value is still validated exactly as before", () => {
  assert.equal(Optional.parse({ namespace: "sample-apps" }).namespace, "sample-apps");
  assert.throws(() => Optional.parse({ namespace: "Not-A-Namespace" }), z.ZodError);
  assert.throws(() => Defaulted.parse({ window: "yesterday" }), z.ZodError);
});

test("whitespace is NOT treated as blank — it is a typo, and silently dropping it hides one", () => {
  assert.throws(() => Optional.parse({ namespace: " " }), z.ZodError);
});
