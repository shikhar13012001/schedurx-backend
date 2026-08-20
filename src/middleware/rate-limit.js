// Simple in-memory per-IP rate limiter — ported from schedurx-form-agent's
// own POST /api/intake, which had the same 10-req/min shape. Good enough for
// a single-process deployment (matches how this backend actually runs); it
// resets on restart and doesn't coordinate across instances, unlike a
// Redis-backed limiter, but nothing here runs more than one instance.

function createRateLimiter({ windowMs = 60_000, max = 10 } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Opportunistic cleanup so `hits` doesn't grow unbounded over the life of
  // a long-running process — this middleware guards a small, low-traffic
  // public surface, so a plain interval sweep is simpler than tracking LRU.
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (now > entry.resetAt) hits.delete(ip);
    }
  }, windowMs).unref();

  function rateLimit(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    const entry = hits.get(ip);

    if (!entry || now > entry.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= max) {
      return res.status(429).json({
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests — please wait a moment and try again.",
          details: null,
        },
      });
    }
    entry.count += 1;
    return next();
  }

  rateLimit.stop = () => clearInterval(sweepTimer);
  return rateLimit;
}

module.exports = { createRateLimiter };
