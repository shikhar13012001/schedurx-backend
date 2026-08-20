const pino = require("pino");
const { config } = require("./config");

const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: ["req.headers.authorization", "req.headers.x-api-key", "response.body", "*.apiKey"],
    remove: true,
  },
});

module.exports = { logger };
