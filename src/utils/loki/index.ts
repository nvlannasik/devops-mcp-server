interface LokiStream {
  stream: Record<string, string>;
  values: [string, string][];
}

export interface LogEntry {
  timestamp: string;
  labels: Record<string, string>;
  line: string;
}

export function parseStreams(result: LokiStream[]): LogEntry[] {
  return result.flatMap((stream) =>
    stream.values.map(([ts, line]) => ({
      timestamp: new Date(parseInt(ts) / 1e6).toISOString(),
      labels: stream.stream,
      line,
    }))
  );
}
