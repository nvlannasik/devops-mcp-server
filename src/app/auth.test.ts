import { test } from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqualStr } from "./index.js";

test("matching tokens compare equal", () => {
  assert.equal(timingSafeEqualStr("s3cr3t-token", "s3cr3t-token"), true);
});

test("different tokens of equal length compare unequal", () => {
  assert.equal(timingSafeEqualStr("s3cr3t-token", "s3cr3t-toben"), false);
});

test("different lengths do not throw and compare unequal", () => {
  // the whole reason for the sha256 step — raw timingSafeEqual throws on length mismatch
  assert.equal(timingSafeEqualStr("short", "a-much-longer-token"), false);
  assert.equal(timingSafeEqualStr("", "x"), false);
});
