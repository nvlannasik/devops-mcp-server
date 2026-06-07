import AppServer from "./src/app/index.js";

const app = new AppServer();

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down...`);
  await app.stop();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

app.start().catch((err: unknown) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
