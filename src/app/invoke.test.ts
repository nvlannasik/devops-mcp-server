import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeTool } from "./invoke.js";
import type { Tool } from "../tools/types.js";

function tool(handler: (input: unknown) => Promise<unknown>): Tool {
  return {
    name: "t_probe",
    description: "test tool",
    inputSchema: {
      type: "object",
      properties: { namespace: { type: "string" }, filter: { type: "array", items: { type: "string" } } },
      required: ["namespace"],
    },
    handler,
  };
}

test("valid args reach the handler parsed, and the result is its JSON", async () => {
  let seen: unknown;
  const out = await invokeTool(tool(async (i) => { seen = i; return { pods: 2 }; }), { namespace: "sample-apps" });
  assert.deepEqual(seen, { namespace: "sample-apps" });
  assert.deepEqual(out, { text: '{"pods":2}', isError: false });
});

test("a string where an array is expected is absorbed the way the HTTP path absorbs it", async () => {
  let seen: any;
  await invokeTool(tool(async (i) => { seen = i; return 1; }), { namespace: "x", filter: "" });
  assert.deepEqual(seen.filter, []);
});

test("invalid args never reach the handler", async () => {
  let called = false;
  const out = await invokeTool(tool(async () => { called = true; return 1; }), { filter: ["a"] });
  assert.equal(called, false);
  assert.equal(out.isError, true);
  assert.match(out.text, /^Error: invalid arguments for t_probe: namespace/);
});

test("a handler that throws is an isError outcome, not an exception", async () => {
  const out = await invokeTool(tool(async () => { throw new Error("boom"); }), { namespace: "x" });
  assert.deepEqual(out, { text: "Error: boom", isError: true });
});

test("a secret value in a tool result never leaves invokeTool, on any transport", async () => {
  const out = await invokeTool(
    tool(async () => ({ args: ["tunnel", "run", "--token", "eyJhIjoiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJ0IjoiZmFrZSJ9"] })),
    { namespace: "default" }
  );
  assert.equal(out.text, '{"args":["tunnel","run","--token","[REDACTED]"]}');
});
