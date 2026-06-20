import { test } from "node:test";
import assert from "node:assert/strict";
import { withTimeout, TimeoutError } from "./index.js";

test("resolves with the value when the promise settles in time", async () => {
  const result = await withTimeout(Promise.resolve(42), 1000, "fast");
  assert.equal(result, 42);
});

test("rejects with TimeoutError when the promise hangs past the deadline", async () => {
  const hang = new Promise<number>(() => {}); // never settles
  await assert.rejects(
    () => withTimeout(hang, 20, "hung upstream"),
    (err: unknown) => {
      assert.ok(err instanceof TimeoutError);
      assert.equal(err.label, "hung upstream");
      assert.equal(err.ms, 20);
      return true;
    },
  );
});

test("propagates the original rejection unchanged", async () => {
  const boom = Promise.reject(new Error("upstream 500"));
  await assert.rejects(() => withTimeout(boom, 1000, "x"), /upstream 500/);
});

test("clears its timer so a settled call does not keep the event loop alive", async () => {
  // if the timer leaked, the test process would hang ~10s after this resolves
  await withTimeout(Promise.resolve("ok"), 10_000, "leak-check");
  assert.ok(true);
});
