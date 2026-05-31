import winston from "winston";

const env = process.env.NODE_ENV || "dev";
const isDev = env === "dev";

const levels = { error: 0, warn: 1, info: 2, http: 3, debug: 4 };
const colors = { error: "red", warn: "yellow", info: "green", http: "magenta", debug: "white" };

winston.addColors(colors);

interface LogContext {
  correlationId?: string;
  toolName?: string;
  duration?: number;
  status?: "ok" | "error" | number | string;
  [key: string]: unknown;
}

const structuredFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  winston.format.errors({ stack: true }),
  winston.format.printf((info) => {
    const context = info.context || {};
    const meta = Object.entries(context)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const metaStr = meta ? ` ${meta}` : "";
    const error = info.stack ? `\n${info.stack}` : "";
    return `${info.timestamp} [${info.level.toUpperCase()}]${metaStr} ${info.message}${error}`;
  })
);

const devFormat = winston.format.combine(
  structuredFormat,
  winston.format.colorize({ all: true })
);

const prodFormat = structuredFormat;

const logger = winston.createLogger({
  level: isDev ? "debug" : "info",
  levels,
  transports: [
    // Console: all levels in dev, info+ in prod
    new winston.transports.Console({
      format: isDev ? devFormat : prodFormat,
    }),
    // Error file: always log errors
    ...(env === "prod"
      ? [
          new winston.transports.File({
            filename: "/var/log/mcp-server/error.log",
            level: "error",
            format: prodFormat,
            maxsize: 10485760, // 10MB
            maxFiles: 10,
          }),
          new winston.transports.File({
            filename: "/var/log/mcp-server/combined.log",
            format: prodFormat,
            maxsize: 10485760,
            maxFiles: 10,
          }),
        ]
      : []),
  ],
});

// Helper to log with context
export function logWithContext(level: "error" | "warn" | "info" | "http" | "debug", message: string, context?: LogContext) {
  logger.log(level, message, { context: context || {} });
}

export default logger;
