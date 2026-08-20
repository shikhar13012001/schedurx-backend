const crypto = require("node:crypto");

// Returns Express middleware enforcing `Authorization: Bearer <expectedKey>`.
// Parameterized so the same timing-safe check can guard both the Ultravox-facing
// tool routes (TOOLS_API_KEY) and the demo-api-facing internal routes (INTERNAL_API_KEY).
function bearerAuth(expectedKey) {
  return function (req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const token = auth.slice(7);

    if (token.length !== expectedKey.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedKey))) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    next();
  };
}

module.exports = { bearerAuth };
