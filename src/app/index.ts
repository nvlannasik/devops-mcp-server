import { createServer, type Server } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z, type ZodTypeAny } from "zod";
import express, { type Request, type Response } from "express";
import crypto from "crypto";
import logger, { logWithContext } from "../utils/logger/log.js";
import allTools from "../tools/index.js";
import config from "../config/index.js";
import { withTimeout } from "../utils/timeout/index.js";

// hard ceiling per tool call — sits just above the upstream HTTP/K8s timeouts so
// their specific errors surface first, but still bounds anything that ignores them
const TOOL_HANDLER_TIMEOUT_MS = config.upstreamTimeoutMs + 5000;

type PropSchema = { type?: string; enum?: string[]; description?: string };
type InputSchema = { properties?: Record<string, PropSchema>; required?: string[] };

function jsonSchemaToZod(schema: InputSchema): Record<string, ZodTypeAny> {
  if (!schema?.properties) return {};
  return Object.fromEntries(
    Object.entries(schema.properties).map(([key, prop]) => {
      let zodType: ZodTypeAny;
      if (prop.type === "number") zodType = z.number();
      else if (prop.type === "boolean") zodType = z.boolean();
      else if (prop.enum) zodType = z.enum(prop.enum as [string, ...string[]]);
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
  }

  private _registerTools(): void {
    const startupId = crypto.randomUUID();
    this._registerToolsOn(this.server, startupId);
  }

  private _registerToolsOn(server: McpServer, correlationId?: string): void {
    for (const tool of allTools) {
      const shape = jsonSchemaToZod(tool.inputSchema as InputSchema);
      server.tool(tool.name, tool.description, shape, async (args) => {
        const start = Date.now();
        const inputStr = JSON.stringify(args).slice(0, 200);
        const cid = correlationId || "unknown";

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

          logWithContext("error", `Tool failed: ${tool.name}`, {
            correlationId: cid,
            toolName: tool.name,
            status: "error",
            duration,
            error: errorMsg,
            stack: err instanceof Error ? err.stack : undefined,
          });

          return {
            content: [{ type: "text" as const, text: `Error: ${errorMsg}` }],
            isError: true,
          };
        }
      });
    }
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
