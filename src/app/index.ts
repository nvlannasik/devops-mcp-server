import { createServer, type Server } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import axios from "axios";
import crypto from "crypto";
import logger, { logWithContext } from "../utils/logger/log.js";
import allTools from "../tools/index.js";
import config from "../config/index.js";
import { invokeTool, jsonSchemaToZod, type InputSchema } from "./invoke.js";
import { startSqsBridge } from "./sqs-loop.js";
export { jsonSchemaToZod } from "./invoke.js";

// Constant-time string compare. Hash first so inputs are always equal length
// (timingSafeEqual throws on length mismatch) and the token length never leaks.
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ah = crypto.createHash("sha256").update(a).digest();
  const bh = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}



export default class AppServer {
  private server: McpServer;
  private httpServer: Server | null = null;
  private bridgeAbort: AbortController | null = null;
  private bridgeDone: Promise<void> | null = null;

  constructor() {
    this.server = new McpServer({ name: "devops-mcp-server", version: "1.0.0" });
    this._registerTools();
    logWithContext("info", `MCP Server initialized with ${allTools.length} tools`, {
      toolCount: allTools.length,
    });
    if (config.writeTools.enabled) {
      const allowed = config.writeTools.allowedNamespaces;
      logWithContext("warn", `WRITE TOOLS ENABLED — allowed namespaces: ${allowed.length ? allowed.join(", ") : "(none — all blocked until ALLOWED_REMEDIATION_NAMESPACES is set)"}`, {});
      // A relaxed orphan floor announces itself, every boot, for as long as it stays relaxed.
      // Age is the only evidence of abandonment `k8s_delete_orphan` has, the benchmark and
      // production share this server, and a guard lowered for a test run stays lowered until
      // somebody puts it back — which is the kind of thing found six weeks later by accident
      // unless the process says so itself.
      const floor = config.writeTools.minOrphanAgeDays;
      if (floor < 14) {
        logWithContext(
          "warn",
          `ORPHAN AGE FLOOR LOWERED — MIN_ORPHAN_AGE_DAYS=${floor} (default 14). k8s_delete_orphan will accept objects ` +
            `${floor === 0 ? "of any age, including ones created seconds ago" : `as young as ${floor} day(s)`}. ` +
            `Age is the only evidence of abandonment this server has; restore the default once the run that needed it is over.`,
          {}
        );
      }
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
        const { text, isError } = await invokeTool(tool, args, correlationId);
        return isError
          ? { content: [{ type: "text" as const, text }], isError: true }
          : { content: [{ type: "text" as const, text }] };
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

    if (inCluster && transport !== "http" && transport !== "sqs") {
      logWithContext("error", "Invalid transport configuration for cluster deployment", {
        inCluster: true,
        transport,
        required: "http or sqs",
      });
      process.exit(1);
    }

    // A bridge's observability URLs belong to the central server: probing them from a workload
    // cluster only produces false alarms.
    if (transport !== "sqs") await this._checkUpstreams();

    if (transport === "http") await this._startHttp();
    else if (transport === "sqs") this._startSqs();
    else await this._startStdio();
  }

  private _startSqs(): void {
    this.bridgeAbort = new AbortController();
    this.bridgeDone = startSqsBridge(this.bridgeAbort.signal).catch((err: unknown) => {
      logWithContext("error", `SQS bridge failed: ${err instanceof Error ? err.message : String(err)}`, {});
      process.exit(1);
    });
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
    if (this.bridgeAbort) { this.bridgeAbort.abort(); await this.bridgeDone; }
    await new Promise<void>((resolve) => {
      if (!this.httpServer) { resolve(); return; }
      this.httpServer.close(() => resolve());
    });
    logWithContext("info", "MCP Server stopped", {});
  }
}
