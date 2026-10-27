import AppServer from "./src/app/index.js";
import { activeTracing } from "./src/tracing/handle.js";

const app = new AppServer();

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down...`);
  await app.stop();
  // Flush the spans the preload's SDK still holds; a no-op when tracing is off.
  await activeTracing()?.shutdown();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

app.start().catch((err: unknown) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
