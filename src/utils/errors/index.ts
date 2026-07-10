export class McpToolError extends Error {
  constructor(message: string, public readonly tool: string, public readonly cause?: unknown) {
    super(message);
    this.name = "McpToolError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly service: "kubernetes" | "prometheus" | "loki" | "tracing",
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// K8s client (ApiException) errors embed the whole HTTP exchange — status line, escaped
// body, headers, audit-id — in .message. Only the API's own message ("pods \"x\" not
// found") helps the model; the rest is token noise inside tool_results. Prefer the parsed
// .body.message, otherwise cut the message off before the Body/Headers dump. The original
// error stays attached as `cause` for debugging.
export function conciseCause(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { body?: unknown; message?: string };
    const body = typeof e.body === "string" ? tryParseJson(e.body) : e.body;
    const msg = (body as { message?: unknown } | undefined)?.message;
    if (typeof msg === "string" && msg) return msg;
    if (typeof e.message === "string") return e.message.split(/\n(?:Body|Headers):/)[0].replace(/\n/g, " ").trim();
  }
  return String(err);
}

export async function withUpstream<T>(
  service: "kubernetes" | "prometheus" | "loki" | "tracing",
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new UpstreamError(`${label}: ${conciseCause(err)}`, service, err);
  }
}
