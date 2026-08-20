// Serves docs/openapi.yaml as an interactive Swagger UI at /docs, and the raw
// spec (parsed to JSON) at /docs/openapi.json. Unconditional — no client/env
// var gates this, unlike the integration-specific routers below it.

const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");
const swaggerUi = require("swagger-ui-express");

const SPEC_PATH = path.join(__dirname, "..", "docs", "openapi.yaml");

function loadSpec() {
  const raw = fs.readFileSync(SPEC_PATH, "utf8");
  return yaml.load(raw);
}

function mountDocs(app) {
  // Re-read + re-parse per request rather than caching at require-time — this file
  // changes often during development and a stale cached spec is worse than the
  // trivial cost of re-parsing a small YAML file on each /docs hit.
  app.get("/docs/openapi.json", (request, response) => {
    response.json(loadSpec());
  });

  app.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(null, {
      swaggerOptions: { url: "/docs/openapi.json" },
    }),
  );
}

module.exports = { mountDocs };
