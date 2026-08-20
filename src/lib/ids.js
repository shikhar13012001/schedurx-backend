const crypto = require("node:crypto");

// Every table in this project uses opaque prefixed-string ids (apt_..., pat_...),
// never native `uuid` columns — this centralizes that pattern for new services.
function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

module.exports = { makeId };
