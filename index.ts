import AppServer from "./src/app/index.js";

const app = new AppServer();
app.start().catch((err: unknown) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
