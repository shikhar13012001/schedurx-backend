// Structured success/error envelope shared by every /api/v1/* route and the
// calendar tool routes. Extracted from calendar-tool-helpers.js so new REST
// routes don't need to depend on a file named for calendar tools specifically.

function ok(res, data, message) {
  return res.json({ success: true, data, message: message ?? null });
}

function fail(res, statusCode, code, message, details) {
  return res.status(statusCode).json({
    success: false,
    error: { code, message, details: details ?? null },
  });
}

module.exports = { ok, fail };
