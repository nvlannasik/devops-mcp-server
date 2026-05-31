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
    public readonly service: "kubernetes" | "prometheus" | "loki",
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export async function withUpstream<T>(
  service: "kubernetes" | "prometheus" | "loki",
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new UpstreamError(`${label}: ${cause}`, service, err);
  }
}
