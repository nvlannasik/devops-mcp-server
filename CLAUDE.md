# devops-mcp-server

MCP (Model Context Protocol) server exposing DevOps tools (Kubernetes, Prometheus, Loki,
Tracing) consumed by `devops-ai-agent`. Part of a 3-repo system: `devops-ai-agent`,
`devops-mcp-server` (this), `llm-worker`.

**Read `MEMORY_BANK.md` before adding tools or touching transport/auth** — it holds the
architecture and design decisions.

## Commands
- Build: `npm run build` (tsc → `dist/`)
- Test: `npm test` (`node:test` + tsx, zero extra deps)
- Dev: `npm run dev`
- **Node 24 required.** Default shell node is v14 — use `~/.nvm/versions/node/v24.16.0/bin` on the PATH.

## Conventions
- TypeScript ESM (NodeNext). Test files `*.test.ts` excluded from the build.
- Tools live in `src/tools/<domain>/`; register by adding to the spread in `src/tools/index.ts`.

## Gotchas (see MEMORY_BANK.md for the full list)
- **Tools are auto-discovered** by the agent via `listTools()` — adding a server-side tool needs **no agent change**. Conversely, the agent caches the tool list at startup, so a tool that's listed but fails on call makes the LLM loop (relevant for any future gated/write tools: register conditionally, don't just guard the handler).
- **HTTP mode is stateless:** a fresh `McpServer` is created per `/mcp` request.
- **Auth:** `/mcp` requires `Authorization: Bearer <MCP_AUTH_TOKEN>` when set (constant-time check); `/health` stays open for probes. Unset token in http mode logs a warning — never silently open.
- **Tracing backends:** Tempo or Jaeger only (adapters in `src/tools/tracing/adapters.ts`). OTel Collector is ingest-only — not a query backend.
- **`flux_reconcile`** is the one write tool the GitOps guard does not refuse — it restores the repo's declared state instead of introducing new state. Its namespace guard runs on the **workload's** namespace (the HelmRelease usually lives in the permanently-blocked `flux-system`), and the target release is derived from the workload's Flux labels, never named by the caller. Needs `patch` on `helmreleases` — **granted in the dev overlay only**.
- **`conciseCause()` handles axios errors** (`err.response.data`), not just K8s `ApiException`. Prometheus/Loki/tracing failures otherwise reach the model as a bare `Request failed with status code 400`, and it retries the same broken query.
- **`k8s_cluster_health` must never inherit `config.k8sListLimit`.** Every other list tool is per-namespace and capped; this one is the cluster-wide *scan*, so a cap would turn a complete answer back into a partial one that still reads as complete — the exact bug it was built to kill (the agent once said "all healthy" after seeing 6 of 20 namespaces). It pages via `_continue` and reports `scanned.complete:false` if it ever hits its own ceiling. Judge pods on **readiness, not phase** — a CrashLoopBackOff pod's phase is `Running`.

## Working style
- Chat in Indonesian; keep technical/English terms untranslated. **Docs are written in English.**
- Don't commit or push unless asked.
