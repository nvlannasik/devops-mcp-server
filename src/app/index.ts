import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z, type ZodTypeAny } from "zod";
import express, { type Request, type Response } from "express";
import logger from "../utils/logger/log.js";
import allTools from "../tools/index.js";

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

  constructor() {
    this.server = new McpServer({ name: "devops-mcp-server", version: "1.0.0" });
    this._registerTools();
  }

  private _registerTools(): void {
    for (const tool of allTools) {
      const shape = jsonSchemaToZod(tool.inputSchema as InputSchema);
      this.server.tool(tool.name, tool.description, shape, async (args) => {
        try {
          const result = await tool.handler(args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`[${tool.name}] ${message}`);
          return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
        }
      });
    }
    logger.info(`Registered ${allTools.length} tools`);
  }

  async start(): Promise<void> {
    const transport = process.env.TRANSPORT || "stdio";
    if (transport === "http") {
      await this._startHttp();
    } else {
      await this._startStdio();
    }
  }

  private async _startStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info("DevOps MCP Server running on stdio");
  }

  private async _startHttp(): Promise<void> {
    const port = parseInt(process.env.PORT ?? "3000");
    const app = express();
    app.use(express.json());

    app.post("/mcp", async (req: Request, res: Response) => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await this.server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    app.get("/health", (_req: Request, res: Response) => {
      res.json({ status: "ok", tools: allTools.length });
    });

    app.listen(port, () => {
      logger.info(`DevOps MCP Server running on HTTP port ${port}`);
      logger.info(`Endpoint: POST http://localhost:${port}/mcp`);
    });
  }
}
