import crypto from "crypto";
import { z, type ZodTypeAny } from "zod";
import { logWithContext } from "../utils/logger/log.js";
import config from "../config/index.js";
import { withTimeout } from "../utils/timeout/index.js";
import { UpstreamError, ValidationError } from "../utils/errors/index.js";
import type { Tool } from "../tools/types.js";

// hard ceiling per tool call — sits just above the upstream HTTP/K8s timeouts so
// their specific errors surface first, but still bounds anything that ignores them
export const TOOL_HANDLER_TIMEOUT_MS = config.upstreamTimeoutMs + 5000;

type PropSchema = { type?: string; enum?: string[]; description?: string; items?: { type?: string } };
export type InputSchema = { properties?: Record<string, PropSchema>; required?: string[] };

export function jsonSchemaToZod(schema: InputSchema): Record<string, ZodTypeAny> {
  if (!schema?.properties) return {};
  return Object.fromEntries(
    Object.entries(schema.properties).map(([key, prop]) => {
      let zodType: ZodTypeAny;
      if (prop.type === "number") zodType = z.number();
      else if (prop.type === "boolean") zodType = z.boolean();
      else if (prop.enum) zodType = z.enum(prop.enum as [string, ...string[]]);
      // Arrays had no case here, so they fell through to z.string() — and since the SDK
      // derives the ADVERTISED schema from this shape, not from tool.inputSchema, an array
      // param was published to the model as a string. It then sent one, the SDK accepted it,
      // and the handler's own z.array() rejected it. z.preprocess still publishes as
      // `type: array`, and absorbs the string a small model sends anyway ("" = no filter).
      else if (prop.type === "array")
        zodType = z.preprocess(
          (v) => (typeof v === "string" ? (v ? [v] : []) : v),
          z.array(prop.items?.type === "number" ? z.number() : z.string())
        );
      else zodType = z.string();

      if (prop.description) zodType = zodType.describe(prop.description);
      const required = schema.required?.includes(key);
      return [key, required ? zodType : zodType.optional()];
    })
  );
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
}

/**
 * The one place a tool runs, for every transport — validation, the timeout, the log lines.
 * Over HTTP the MCP SDK has already validated against the same shape (re-validating is a
 * no-op there); over SQS nothing has, so this is what stands between a queue message and a
 * handler. Two transports with two copies of this logic would drift the first time either
 * changed.
 */
export async function invokeTool(tool: Tool, rawArgs: unknown, correlationId?: string): Promise<ToolOutcome> {
  const start = Date.now();
  const cid = correlationId ?? crypto.randomUUID();

  const parsed = z.object(jsonSchemaToZod(tool.inputSchema as InputSchema)).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
    logWithContext("warn", `Tool input rejected: ${tool.name}`, { correlationId: cid, toolName: tool.name, error: msg });
    return { text: `Error: invalid arguments for ${tool.name}: ${msg}`, isError: true };
  }
  const args = parsed.data;
  const inputStr = JSON.stringify(args).slice(0, 200);
  logWithContext("debug", `Tool called: ${tool.name}`, { correlationId: cid, toolName: tool.name, input: inputStr });

  try {
    const result = await withTimeout(tool.handler(args), TOOL_HANDLER_TIMEOUT_MS, `tool ${tool.name}`);
    const duration = Date.now() - start;
    const resultStr = JSON.stringify(result);
    const resultSize = Buffer.byteLength(resultStr, "utf8");
    logWithContext("info", `Tool executed: ${tool.name}`, {
      correlationId: cid,
      toolName: tool.name,
      status: "ok",
      duration,
      resultSize: `${(resultSize / 1024).toFixed(2)}KB`,
    });
    return { text: resultStr, isError: false };
  } catch (err) {
    const duration = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Expected operational failures (upstream down, pod not found, bad input) log as
    // one line — a stack of wrapper frames adds nothing. Unexpected errors keep the
    // stack: those are the actual bugs.
    const expected = err instanceof UpstreamError || err instanceof ValidationError;
    logWithContext("error", `Tool failed: ${tool.name}`, {
      correlationId: cid,
      toolName: tool.name,
      status: "error",
      duration,
      // the args are logged at debug only, so in prod (info) a failure used to
      // arrive with no way to tell WHICH call broke — repeat them on the error path
      input: inputStr,
      error: errorMsg,
      ...(expected ? {} : { stack: err instanceof Error ? err.stack : undefined }),
    });
    return { text: `Error: ${errorMsg}`, isError: true };
  }
}
