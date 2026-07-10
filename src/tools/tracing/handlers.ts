import { z } from "zod";
import { getAdapter } from "./client.js";
import { withUpstream, ValidationError } from "../../utils/errors/index.js";

// Accept RFC3339 (e.g. 2026-06-24T10:00:00Z) or Unix seconds. Returns Unix seconds.
function toSec(v: string | undefined, fallbackSec: number): number {
  if (!v) return fallbackSec;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  const ms = Date.parse(v);
  if (isNaN(ms)) throw new ValidationError(`Invalid time "${v}" — use RFC3339 or Unix seconds`);
  return Math.floor(ms / 1000);
}

export const searchTraces = (input: unknown) => {
  const { service, minDurationMs, start, end, limit } = z
    .object({
      service: z.string().optional(),
      minDurationMs: z.number().int().positive().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      limit: z.number().int().positive().default(20),
    })
    .parse(input);
  const nowSec = Math.floor(Date.now() / 1000);
  const endSec = toSec(end, nowSec);
  const startSec = toSec(start, nowSec - 3600);
  return withUpstream("tracing", "Trace search failed", () =>
    getAdapter().searchTraces({ service, minDurationMs, startSec, endSec, limit })
  );
};

export const getTrace = (input: unknown) => {
  const { traceId } = z.object({ traceId: z.string().min(1) }).parse(input);
  return withUpstream("tracing", `Failed to get trace ${traceId}`, () => getAdapter().getTrace(traceId));
};

export const listServices = (input: unknown) => {
  z.object({}).parse(input ?? {});
  return withUpstream("tracing", "Failed to list traced services", () => getAdapter().listServices());
};
