/**
 * What an EMPTY PromQL vector means — the same silent failure as an empty Loki answer, one signal
 * further out.
 *
 * PromQL answers a metric name that does not exist exactly the way it answers "no series crossed
 * this threshold": `{"resultType":"vector","result":[]}`. Measured 2026-08-31 in devops-ai-agent:
 * the prompt shipped `http_requests_total` while the apps expose `http_server_requests_total`, the
 * call logged `prometheus_query ok (35 chars)`, and the agent investigating an error-rate spike
 * could not read the metric that fired it — and nothing said the NAME was the problem. That fix was
 * a prompt allowlist; this is the same check at the source, for every name the model writes on the
 * fly and no allowlist can anticipate.
 *
 * Only a name followed by `{` or `[` is treated as a metric, and both are safe in one direction: a
 * function call is followed by `(`, a label name sits INSIDE braces, a duration starts with a digit,
 * so what matches is a selector. `[` was not in the first version — the heuristic was copied from
 * the agent's `skills/real.test.ts`, which only needs `{` for the prompt's own examples — and the
 * first query run against the live Prometheus, `sum(rate(http_server_requests_total[5m])) > 1e9`,
 * came back with no note at all: a bare range selector, the most common form a model writes. A bare
 * `up == 0` is still missed, and missing it means no note — today's behaviour, never a wrong one.
 */

const SELECTOR = /([a-zA-Z_:][a-zA-Z0-9_:]*)\s*[{[]/g;

export function metricsInQuery(query: string): string[] {
  return [...new Set([...query.matchAll(SELECTOR)].map((m) => m[1]))];
}

// A comparison outside every `{...}` and `[...]` filters series out by value, so an empty result
// can be the ANSWER ("nothing is above the threshold"). Matchers inside braces use `=`/`!=` too —
// hence stripping them first.
const COMPARISON = /(?:[<>]=?|==|!=)/;
const hasComparison = (query: string) => COMPARISON.test(query.replace(/\{[^}]*\}|\[[^\]]*\]/g, ""));

// The measured failure was a near miss — `http_requests_total` against `http_server_requests_total`
// — so a suggestion is a known name holding every `_`-separated token of the unknown one, in order.
// Three at most: this is a hint for the model, not a search result.
function nearMisses(unknown: string, known: ReadonlySet<string>): string[] {
  const tokens = unknown.split(/[_:]/).filter(Boolean);
  const out: string[] = [];
  for (const name of known) {
    let at = 0;
    const ok = tokens.every((t) => {
      const i = name.indexOf(t, at);
      if (i < 0) return false;
      at = i + t.length;
      return true;
    });
    if (ok && name !== unknown) out.push(name);
    if (out.length === 3) break;
  }
  return out;
}

export interface EmptyVectorNote {
  emptyResult: "unknown_metric" | "no_series_match";
  unknownMetrics?: string[];
  didYouMean?: string[];
  note: string;
}

/** null when the query names no selector we can check — the caller then returns the plain result. */
export function explainEmptyVector(query: string, known: ReadonlySet<string>): EmptyVectorNote | null {
  const names = metricsInQuery(query);
  if (names.length === 0) return null;
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length > 0) {
    const didYouMean = [...new Set(unknown.flatMap((u) => nearMisses(u, known)))];
    return {
      emptyResult: "unknown_metric",
      unknownMetrics: unknown,
      ...(didYouMean.length ? { didYouMean } : {}),
      note:
        `${unknown.map((u) => `\`${u}\``).join(", ")} does not exist in this Prometheus. This empty result ` +
        "means the metric NAME is wrong — not that the value is zero, and not that anything is healthy. " +
        (didYouMean.length ? `Did you mean ${didYouMean.map((d) => `\`${d}\``).join(" or ")}? ` : "") +
        "prometheus_list_metric_names lists every name that exists.",
    };
  }
  return {
    emptyResult: "no_series_match",
    note: hasComparison(query)
      ? "Every metric in this query exists. The expression compares against a threshold, so an empty result " +
        "means no series crossed it — which can itself be the answer. To see the actual values, re-run it " +
        "without the comparison."
      : "Every metric in this query exists, but no series matched these label matchers in this window. Check " +
        "the label values (a `service`, `namespace` or `job` spelled differently), or drop matchers until " +
        "something returns, before concluding there is no data.",
  };
}
