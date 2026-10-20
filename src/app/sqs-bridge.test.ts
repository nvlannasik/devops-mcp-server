import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBridgeMessage, parseBridgeRequest, fitResponse, MAX_RESPONSE_BYTES, type BridgeDeps } from "./sqs-bridge.js";
import type { Tool } from "../tools/types.js";

const NOW = 1_760_000_000_000;
const readTool: Tool = { name: "k8s_list_pods", description: "list", inputSchema: { type: "object", properties: {} }, handler: async () => [] };
const writeTool: Tool = { name: "k8s_restart_deployment", description: "restart", inputSchema: { type: "object", properties: {} }, handler: async () => ({ ok: true }) };

// The literal pinned on BOTH sides of the contract (the agent's sqs-client.test.ts holds the same keys).
const CONTRACT_REQUEST = { requestId: "r-1", op: "call_tool", tool: "k8s_list_pods", args: { namespace: "sample-apps" }, deadline: NOW + 30_000, traceId: "1791903072.183579" };

function harness(over: Partial<BridgeDeps> = {}) {
  const events: string[] = [];
  const replies: Array<{ requestId: string; body: any }> = [];
  const deps: BridgeDeps = {
    tools: [readTool, writeTool],
    writeToolNames: new Set([writeTool.name]),
    invoke: async (t) => { events.push(`invoke:${t.name}`); return { text: '"ok"', isError: false }; },
    reply: async (requestId, body) => { events.push("reply"); replies.push({ requestId, body: JSON.parse(body) }); },
    remove: async () => { events.push("remove"); },
    now: () => NOW,
    ...over,
  };
  return { deps, events, replies };
}

test("contract: the pinned request parses, and a call_tool reply carries content", async () => {
  const p = parseBridgeRequest(JSON.stringify(CONTRACT_REQUEST));
  assert.ok("request" in p);
  const h = harness();
  await handleBridgeMessage(JSON.stringify(CONTRACT_REQUEST), h.deps);
  assert.deepEqual(h.replies[0], { requestId: "r-1", body: { requestId: "r-1", response: { content: '"ok"', isError: false } } });
});

test("list_tools lists the registered tools — write tools only if they were registered", async () => {
  const h = harness({ tools: [readTool] });
  await handleBridgeMessage(JSON.stringify({ requestId: "r-2", op: "list_tools", deadline: NOW + 1000 }), h.deps);
  assert.deepEqual(h.replies[0].body.response.tools.map((t: any) => t.name), ["k8s_list_pods"]);
  assert.deepEqual(Object.keys(h.replies[0].body.response.tools[0]).sort(), ["description", "inputSchema", "name"]);
});

test("an expired request is answered and never executed; inside the 2s skew it still runs", async () => {
  const late = harness();
  await handleBridgeMessage(JSON.stringify({ ...CONTRACT_REQUEST, deadline: NOW - 3000 }), late.deps);
  assert.deepEqual(late.replies[0].body, { requestId: "r-1", error: "expired" });
  assert.ok(!late.events.some((e) => e.startsWith("invoke")));
  assert.ok(late.events.includes("remove"));
  const skewed = harness();
  await handleBridgeMessage(JSON.stringify({ ...CONTRACT_REQUEST, deadline: NOW - 1000 }), skewed.deps);
  assert.ok(skewed.events.includes("invoke:k8s_list_pods"));
});

test("a write is removed BEFORE it runs (at-most-once); a read after its reply (at-least-once)", async () => {
  const w = harness();
  await handleBridgeMessage(JSON.stringify({ ...CONTRACT_REQUEST, tool: "k8s_restart_deployment" }), w.deps);
  assert.deepEqual(w.events, ["remove", "invoke:k8s_restart_deployment", "reply"]);
  const r = harness();
  await handleBridgeMessage(JSON.stringify(CONTRACT_REQUEST), r.deps);
  assert.deepEqual(r.events, ["invoke:k8s_list_pods", "reply", "remove"]);
});

test("a write whose reply send fails ran exactly once and is not left to redeliver", async () => {
  const h = harness({ reply: async () => { throw new Error("send failed"); } });
  await assert.rejects(handleBridgeMessage(JSON.stringify({ ...CONTRACT_REQUEST, tool: "k8s_restart_deployment" }), h.deps));
  assert.deepEqual(h.events, ["remove", "invoke:k8s_restart_deployment"]);
});

test("poison: unparseable is removed silently; a parseable body with a requestId but a bad shape is answered", async () => {
  const junk = harness();
  await handleBridgeMessage("{not json", junk.deps);
  assert.deepEqual(junk.events, ["remove"]);
  const bad = harness();
  await handleBridgeMessage(JSON.stringify({ requestId: "r-3", op: "drop_tables", deadline: NOW + 1000 }), bad.deps);
  assert.equal(bad.replies[0].body.requestId, "r-3");
  assert.match(bad.replies[0].body.error, /op/);
  assert.ok(bad.events.includes("remove"));
});

test("an unknown tool is a transport error, not a crash", async () => {
  const h = harness();
  await handleBridgeMessage(JSON.stringify({ ...CONTRACT_REQUEST, tool: "k8s_nope" }), h.deps);
  assert.deepEqual(h.replies[0].body, { requestId: "r-1", error: "unknown tool: k8s_nope" });
});

test("the cap measures the SERIALIZED body: control chars and emoji expand under JSON escaping", () => {
  for (const unit of ["\u0001", "🔥", "a"]) {
    const content = unit.repeat(300_000); // 300k so even plain ASCII is past the 240 KB cap
    const { body, truncatedFrom } = fitResponse("r-1", content, false);
    assert.ok(Buffer.byteLength(body, "utf8") <= MAX_RESPONSE_BYTES, `${JSON.stringify(unit)}: ${Buffer.byteLength(body)}`);
    assert.ok(truncatedFrom && truncatedFrom > 0);
    const parsed = JSON.parse(body);
    assert.match(parsed.response.content, /\n\[truncated by the bridge: \d+ of \d+ bytes\]$/);
    assert.doesNotMatch(parsed.response.content, /[\ud800-\udbff](?![\udc00-\udfff])/, "no lone high surrogate at the cut");
  }
  const small = fitResponse("r-1", "fine", true);
  assert.equal(small.truncatedFrom, undefined);
  assert.deepEqual(JSON.parse(small.body), { requestId: "r-1", response: { content: "fine", isError: true } });
});
