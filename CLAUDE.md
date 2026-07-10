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

## Working style
- Chat in Indonesian; keep technical/English terms untranslated. **Docs are written in English.**
- Don't commit or push unless asked.
