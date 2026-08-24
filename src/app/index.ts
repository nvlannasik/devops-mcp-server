import { createServer, type Server } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z, type ZodTypeAny } from "zod";
import express, { type Request, type Response } from "express";
import axios from "axios";
import crypto from "crypto";
import logger, { logWithContext } from "../utils/logger/log.js";
import allTools from "../tools/index.js";
import config from "../config/index.js";
import { withTimeout } from "../utils/timeout/index.js";
import { UpstreamError, ValidationError } from "../utils/errors/index.js";

// hard ceiling per tool call — sits just above the upstream HTTP/K8s timeouts so
// their specific errors surface first, but still bounds anything that ignores them
const TOOL_HANDLER_TIMEOUT_MS = config.upstreamTimeoutMs + 5000;

// Constant-time string compare. Hash first so inputs are always equal length
// (timingSafeEqual throws on length mismatch) and the token length never leaks.
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ah = crypto.createHash("sha256").update(a).digest();
  const bh = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

type PropSchema = { type?: string; enum?: string[]; description?: string; items?: { type?: string } };
type InputSchema = { properties?: Record<string, PropSchema>; required?: string[] };

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

export default class AppServer {
  private server: McpServer;
  private httpServer: Server | null = null;

  constructor() {
    this.server = new McpServer({ name: "devops-mcp-server", version: "1.0.0" });
    this._registerTools();
    logWithContext("info", `MCP Server initialized with ${allTools.length} tools`, {
      toolCount: allTools.length,
    });
    if (config.writeTools.enabled) {
      const allowed = config.writeTools.allowedNamespaces;
      logWithContext("warn", `WRITE TOOLS ENABLED — allowed namespaces: ${allowed.length ? allowed.join(", ") : "(none — all blocked until ALLOWED_REMEDIATION_NAMESPACES is set)"}`, {});
    }
  }

  private _registerTools(): void {
    // no id here on purpose: stdio mode used to stamp every tool call for the whole
    // process lifetime with one startup UUID, so calls were indistinguishable in the log.
    // Passing none makes each call generate its own (HTTP still uses its per-request id).
    this._registerToolsOn(this.server);
  }

  private _registerToolsOn(server: McpServer, correlationId?: string): void {
    for (const tool of allTools) {
      const shape = jsonSchemaToZod(tool.inputSchema as InputSchema);
      server.tool(tool.name, tool.description, shape, async (args) => {
        const start = Date.now();
        const inputStr = JSON.stringify(args).slice(0, 200);
        const cid = correlationId ?? crypto.randomUUID();

        logWithContext("debug", `Tool called: ${tool.name}`, {
          correlationId: cid,
          toolName: tool.name,
          input: inputStr,
        });

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

          return { content: [{ type: "text" as const, text: resultStr }] };
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

          return {
            content: [{ type: "text" as const, text: `Error: ${errorMsg}` }],
            isError: true,
          };
        }
      });
    }
  }

  // Non-fatal upstream reachability probe at startup. Any HTTP response (even 4xx)
  // counts as reachable — we're surfacing DNS/connect/timeout misconfig (e.g. a wrong
  // PROMETHEUS_URL) at deploy time instead of at first tool call. Deliberately does NOT
  // fail startup: Prometheus being down must not take the k8s tools down with it.
  private async _checkUpstreams(): Promise<void> {
    const upstreams: Array<[string, string]> = [
      ["prometheus", config.prometheus.url],
      ["alertmanager", config.alertmanager.url],
      ["loki", config.loki.url],
    ];
    if (config.tracing.url) upstreams.push([`tracing(${config.tracing.backend})`, config.tracing.url]);

    await Promise.all(
      upstreams.map(async ([name, url]) => {
        try {
          await axios.get(url, { timeout: 5000, validateStatus: () => true });
          logWithContext("info", `Upstream reachable: ${name}`, { upstream: name, url });
        } catch (err) {
          logWithContext("warn", `Upstream UNREACHABLE: ${name} — its tools will fail until the URL/network is fixed`, {
            upstream: name,
            url,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
    );
  }

  async start(): Promise<void> {
    const transport = process.env.TRANSPORT || "stdio";
    const inCluster = !!process.env.KUBERNETES_SERVICE_HOST;

    if (inCluster && transport !== "http") {
      logWithContext("error", "Invalid transport configuration for cluster deployment", {
        inCluster: true,
        transport,
        required: "http",
      });
      process.exit(1);
    }

    await this._checkUpstreams();

    if (transport === "http") {
      await this._startHttp();
    } else {
      await this._startStdio();
    }
  }

  private async _startStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logWithContext("info", "MCP Server started in stdio mode", { transport: "stdio" });
  }

  private async _startHttp(): Promise<void> {
    const port = parseInt(process.env.PORT ?? "3000");
    const app = express();
    app.use(express.json());

    // Request logging middleware
    app.use((req: Request, res: Response, next: express.NextFunction) => {
      const requestId = crypto.randomUUID();
      const startTime = Date.now();
      res.on("finish", () => {
        const duration = Date.now() - startTime;
        logWithContext("http", `${req.method} ${req.path}`, {
          correlationId: requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration,
        });
      });
      (req as any).id = requestId;
      next();
    });

    // Bearer-token gate on /mcp (NOT /health, so K8s probes stay unauthenticated).
    // Open when MCP_AUTH_TOKEN is unset — but warn, so an exposed server is never silently open.
    const authToken = config.auth.token;
    if (authToken) {
      app.use("/mcp", (req: Request, res: Response, next: express.NextFunction) => {
        const header = req.headers.authorization ?? "";
        const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!provided || !timingSafeEqualStr(provided, authToken)) {
          logWithContext("warn", "Rejected unauthenticated /mcp request", { correlationId: (req as any).id });
          res.status(401).json({ error: "unauthorized" });
          return;
        }
        next();
      });
      logWithContext("info", "MCP HTTP auth enabled (bearer token required on /mcp)", {});
    } else {
      logWithContext("warn", "MCP HTTP running WITHOUT auth — set MCP_AUTH_TOKEN to require a bearer token", {});
    }

    app.post("/mcp", async (req: Request, res: Response) => {
      const requestId = (req as any).id;
      try {
        // Create a fresh server instance per request (stateless HTTP mode)
        const server = new McpServer({ name: "devops-mcp-server", version: "1.0.0" });
        this._registerToolsOn(server, requestId);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logWithContext("error", "MCP request handler failed", {
          correlationId: requestId,
          error: errMsg,
          stack: err instanceof Error ? err.stack : undefined,
        });
        if (!res.headersSent) {
          res.status(500).json({ error: "Internal server error" });
        }
      }
    });

    app.get("/health", (_req: Request, res: Response) => {
      res.json({ status: "ok", tools: allTools.length });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer = createServer(app);
      this.httpServer.listen(port, () => {
        logWithContext("info", "MCP Server started in HTTP mode", {
          transport: "http",
          port,
          endpoint: `http://0.0.0.0:${port}/mcp`,
        });
        resolve();
      });
      this.httpServer.once("error", reject);
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.httpServer) { resolve(); return; }
      this.httpServer.close(() => resolve());
    });
    logWithContext("info", "MCP Server stopped", {});
  }
}
