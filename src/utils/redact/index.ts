/**
 * Secret VALUES out of a tool result before it leaves the cluster — to an LLM provider, the agent's
 * database and its dashboard. Applied once, in invokeTool, for every tool and both transports.
 * 2026-10-28: a cloudflared Deployment carried its tunnel token in `args`, and k8s_get_resource
 * handed it to every backend that investigated an alert on it.
 *
 * Values only: a Secret's NAME, a secretKeyRef, an env var's name are what the agent reasons about
 * (orphan checks, "the pod mounts workload-tls") and stay.
 *
 * ponytail: pattern matching, so evadable and incomplete by construction — a defence in depth, not
 * a guarantee. The text patterns mirror devops-ai-agent/src/replay/redact.ts (separate repos, no
 * shared module); a pattern added on one side belongs on the other.
 */
const MASK = "[REDACTED]";

// A key or env var name that ENDS in a secret word: DB_PASSWORD, clientSecret, token. Not
// secretName / secretKeyRef / tokenTTL — those name or describe a secret rather than hold one.
const SECRET_NAME = /(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)$/i;

const PATTERNS: Array<{ re: RegExp; replace: (m: string, ...g: string[]) => string | null }> = [
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: () => MASK }, // JWT
  { re: /\beyJ[A-Za-z0-9+/_-]{30,}={0,2}/g, replace: () => MASK }, // dotless base64 JSON (cloudflared)
  { re: /\b(Bearer)\s+[A-Za-z0-9\-._~+/]{12,}=*/gi, replace: (_m, kw) => `${kw} ${MASK}` },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => MASK },
  { re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):([^\s/@]+)@/gi, replace: (_m, head) => `${head}:${MASK}@` },
  {
    re: /(--(?:password|passwd|secret|client-secret|token|access-token|api-key|access-key)\b)(\s*=\s*|\s+)([^\s"'&,;}\]]+)/gi,
    replace: (_m, flag, sep, value) => (value.length < 6 || value.startsWith("-") || value.startsWith("[") ? null : `${flag}${sep}${MASK}`),
  },
  {
    re: /\b(password|passwd|pwd|secret|client_secret|aws_secret_access_key|token|access_token|refresh_token|api[_-]?key|access[_-]?key)\b(["']?\s*[:=]\s*["']?)([^\s"'&,;}]+)/gi,
    replace: (_m, key, sep, value) => (value.length < 6 || /^\d+$/.test(value) || value.startsWith("[") ? null : `${key}${sep}${MASK}`),
  },
];

/** Returns the masked copy and how many values were masked (never which — this count is logged). */
export function redactSecrets<T>(input: T): { value: T; hits: number } {
  let hits = 0;
  const text = (s: string): string => {
    let out = s;
    for (const p of PATTERNS) {
      out = out.replace(p.re, (m: string, ...g: unknown[]) => {
        const r = p.replace(m, ...(g.filter((x) => typeof x === "string") as string[]));
        if (r === null) return m;
        hits++;
        return r;
      });
    }
    return out;
  };
  const mask = (v: unknown) => (typeof v === "string" && v.length >= 6 && !/^\d+$/.test(v) ? (hits++, MASK) : walk(v));
  // A container's args put the value in the element after a bare `--token`, so arrays read pairwise.
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) {
      return v.map((x, i) => {
        const prev = v[i - 1];
        return typeof prev === "string" && /^--?[A-Za-z-]*?(password|passwd|secret|token|api-key|access-key)$/i.test(prev) ? mask(x) : walk(x);
      });
    }
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      // env: [{ name: "DB_PASSWORD", value: "…" }]
      const envSecret = typeof o.name === "string" && SECRET_NAME.test(o.name) && "value" in o;
      return Object.fromEntries(
        Object.entries(o).map(([k, x]) => [k, (envSecret && k === "value") || SECRET_NAME.test(k) ? mask(x) : walk(x)])
      );
    }
    return v;
  };
  return { value: walk(input) as T, hits };
}
