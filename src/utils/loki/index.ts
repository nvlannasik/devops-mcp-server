interface LokiStream {
  stream: Record<string, string>;
  values: [string, string][];
}

export interface LogEntry {
  timestamp: string;
  labels: Record<string, string>;
  line: string;
}

/**
 * What an EMPTY log answer means — always a fact about the pipeline or the query, never about the
 * workload, and the agent could not tell which until this existed.
 *
 * An empty result used to come back as `[]`: two characters, identical whether the container
 * printed nothing, the selector named a label the shipper does not set, or the whole log pipeline
 * was dead. Measured 2026-09-24..26: both fluentbit pods wedged and Loki held no line from ANY
 * namespace for 36 hours. Every investigation in that window read `[]` as "the container logged
 * nothing", and a benchmark case whose evidence is one log line failed for two days on a fixture
 * that was fine. It was found by hand, by asking Loki for the namespaces it held at all — which is
 * exactly the probe the handler now runs for itself, and only when the answer is empty.
 *
 * `noLogLines` is a CONTRACT with devops-ai-agent, not decoration: the agent decides whether it has
 * "seen log lines" by the size of a log tool's result (LOG_RESULT_MIN_CHARS), and this object is
 * long enough to pass that test while holding nothing. The agent excludes a result carrying
 * `"noLogLines":true`; rename it and every empty query silently counts as evidence again.
 */
export interface EmptyLogs {
  streams: [];
  noLogLines: true;
  verdict: "pipeline_silent" | "namespace_silent" | "no_match";
  namespacesWithLogs: number;
  note: string;
}

// Only an exact `namespace="x"` matcher names one namespace. `=~` could match several, and saying
// "namespace X is silent" about a regex would be a guess dressed as a finding.
const NAMESPACE_MATCHER = /\bnamespace\s*=\s*"([^"]+)"/;

export function explainEmptyLogs(query: string, namespacesWithLogs: string[]): EmptyLogs {
  const base = { streams: [] as [], noLogLines: true as const, namespacesWithLogs: namespacesWithLogs.length };
  if (namespacesWithLogs.length === 0) {
    return {
      ...base,
      verdict: "pipeline_silent",
      note:
        "Loki holds NO log lines from ANY namespace in this window — the log pipeline was not ingesting. " +
        "This empty result is NOT evidence that the workload logged nothing. Read the container's own " +
        "logs with k8s_get_pod_logs (previous: true for a restarted container), and say in the answer that " +
        "Loki was unavailable as a source.",
    };
  }
  const ns = query.match(NAMESPACE_MATCHER)?.[1];
  if (ns && !namespacesWithLogs.includes(ns)) {
    return {
      ...base,
      verdict: "namespace_silent",
      note:
        `Loki is receiving logs from ${namespacesWithLogs.length} namespace(s) in this window, but none from ` +
        `\`${ns}\`. Either nothing there wrote to stdout/stderr, the namespace name is wrong, or its containers ` +
        "exited before the shipper picked up their log files — a crash-looping container that dies within " +
        "seconds is the usual case. k8s_get_pod_logs reads the kubelet's copy directly (previous: true for " +
        "a restarted container).",
    };
  }
  return {
    ...base,
    verdict: "no_match",
    note:
      `Loki is ingesting${ns ? ` (including from \`${ns}\`)` : ""}, but nothing matched this query. That is a ` +
      "fact about the selector or the line filter, not proof the event never happened: drop the |= / |~ " +
      "or level filter and widen the selector before concluding the logs are clean.",
  };
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
