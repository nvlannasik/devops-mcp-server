import winston from "winston";

const levels = { error: 0, warn: 1, info: 2, http: 3, debug: 4 };
const colors = { error: "red", warn: "yellow", info: "green", http: "magenta", debug: "white" };

winston.addColors(colors);

const format = winston.format.combine(
  winston.format.timestamp({ format: "DD-MM-YYYY HH:mm:ss:ms" }),
  winston.format.printf((info) => `${info.timestamp} - [${info.level.toUpperCase()}] ${info.message}`),
  winston.format.colorize({ all: true })
);

const logger = winston.createLogger({
  level: "http",
  levels,
  format,
  transports: [new winston.transports.Console()],
});

export default logger;
