// The SQS bridge's per-message rules (spec 2026-10-15-multi-cluster-sqs-bridge-design §2). Pure
// apart from the injected deps, so every rule is testable without SQS: the poll loop around it
// (sqs-loop.ts) only receives, and calls this once per message.
import { logWithContext } from "../utils/logger/log.js";
import type { Tool } from "../tools/types.js";
import type { ToolOutcome } from "./invoke.js";

export const CLOCK_SKEW_MS = 2000;
// SQS allows 256 KB; the margin is for the envelope fields and SQS's own accounting.
export const MAX_RESPONSE_BYTES = 240 * 1024;

export interface BridgeRequest {
  requestId: string;
  op: "list_tools" | "call_tool";
  tool?: string;
  args?: Record<string, unknown>;
  deadline: number;
  traceId?: string;
}

export interface BridgeDeps {
  tools: Tool[];
  writeToolNames: ReadonlySet<string>;
  invoke: (tool: Tool, args: unknown, cid?: string) => Promise<ToolOutcome>;
  reply: (requestId: string, body: string) => Promise<void>;
  remove: () => Promise<void>;
  now: () => number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseBridgeRequest(body: string | undefined): { request: BridgeRequest } | { requestId?: string; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(body ?? "");
  } catch {
    return { error: "body is not JSON" };
  }
  if (!isObj(raw) || typeof raw.requestId !== "string" || !raw.requestId) return { error: "no requestId" };
  const requestId = raw.requestId;
  if (raw.op !== "list_tools" && raw.op !== "call_tool") return { requestId, error: `bad op: ${String(raw.op)}` };
  if (typeof raw.deadline !== "number" || !Number.isFinite(raw.deadline)) return { requestId, error: "bad deadline" };
  if (raw.op === "call_tool" && (typeof raw.tool !== "string" || !raw.tool)) return { requestId, error: "call_tool needs a tool" };
  if (raw.args !== undefined && !isObj(raw.args)) return { requestId, error: "args must be an object" };
  if (raw.traceId !== undefined && typeof raw.traceId !== "string") return { requestId, error: "bad traceId" };
  return {
    request: {
      requestId,
      op: raw.op,
      tool: raw.tool as string | undefined,
      args: raw.args as Record<string, unknown> | undefined,
      deadline: raw.deadline,
      traceId: raw.traceId as string | undefined,
    },
  };
}

/**
 * The reply body, cut to fit SQS. Measured on the SERIALIZED body, never on `content`:
 * JSON escaping turns one control character into six bytes, so a cap on content length
 * still overflows. The cut never splits a surrogate pair.
 */
export function fitResponse(requestId: string, content: string, isError: boolean): { body: string; truncatedFrom?: number } {
  const whole = JSON.stringify({ requestId, response: { content, isError } });
  if (Buffer.byteLength(whole, "utf8") <= MAX_RESPONSE_BYTES) return { body: whole };
  const total = Buffer.byteLength(content, "utf8");
  let keep = content.length;
  for (;;) {
    keep = Math.floor(keep * 0.8);
    let cut = content.slice(0, keep);
    if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
    const marked = `${cut}\n[truncated by the bridge: ${Buffer.byteLength(cut, "utf8")} of ${total} bytes]`;
    const body = JSON.stringify({ requestId, response: { content: marked, isError } });
    if (Buffer.byteLength(body, "utf8") <= MAX_RESPONSE_BYTES) return { body, truncatedFrom: total };
  }
}

export async function handleBridgeMessage(body: string | undefined, deps: BridgeDeps): Promise<void> {
  const parsed = parseBridgeRequest(body);
  if ("error" in parsed) {
    logWithContext("warn", `Bridge: unusable request — ${parsed.error}`, { requestId: parsed.requestId });
    if (parsed.requestId) await deps.reply(parsed.requestId, JSON.stringify({ requestId: parsed.requestId, error: parsed.error }));
    await deps.remove();
    return;
  }
  const req = parsed.request;

  // A request the agent stopped waiting for is never executed: a restart that sat in the queue
  // through a bridge outage must not run minutes after a human was told it failed. The same
  // rule bounds a poison read: its redelivery (after the visibility timeout) is already expired.
  if (deps.now() > req.deadline + CLOCK_SKEW_MS) {
    logWithContext("warn", `Bridge: expired request ${req.requestId} (${req.op} ${req.tool ?? ""})`, { requestId: req.requestId });
    await deps.reply(req.requestId, JSON.stringify({ requestId: req.requestId, error: "expired" }));
    await deps.remove();
    return;
  }

  if (req.op === "list_tools") {
    const tools = deps.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    await deps.reply(req.requestId, JSON.stringify({ requestId: req.requestId, response: { tools } }));
    await deps.remove();
    return;
  }

  const tool = deps.tools.find((t) => t.name === req.tool);
  if (!tool) {
    await deps.reply(req.requestId, JSON.stringify({ requestId: req.requestId, error: `unknown tool: ${req.tool}` }));
    await deps.remove();
    return;
  }

  // At-most-once for writes: deleted BEFORE it runs, so a crash mid-call loses the call rather
  // than repeating it. A read is deleted after its reply, so a crash re-runs it — harmless.
  const isWrite = deps.writeToolNames.has(tool.name);
  if (isWrite) await deps.remove();
  const outcome = await deps.invoke(tool, req.args ?? {}, req.traceId ?? req.requestId);
  const { body: out, truncatedFrom } = fitResponse(req.requestId, outcome.text, outcome.isError);
  if (truncatedFrom) {
    logWithContext("warn", `Bridge: ${tool.name} result truncated to fit SQS (${truncatedFrom} bytes)`, { requestId: req.requestId });
  }
  await deps.reply(req.requestId, out);
  if (!isWrite) await deps.remove();
}
