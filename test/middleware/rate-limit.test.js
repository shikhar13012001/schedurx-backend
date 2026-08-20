const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createRateLimiter } = require("../../src/middleware/rate-limit");

function fakeReqRes(ip) {
  const req = { ip };
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonBody = body;
      return this;
    },
  };
  return { req, res, getStatus: () => statusCode, getBody: () => jsonBody };
}

test("createRateLimiter allows requests under the limit and blocks once it's exceeded", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
  const ip = "1.2.3.4";
  let nextCalls = 0;
  const next = () => nextCalls++;

  for (let i = 0; i < 3; i++) {
    const { req, res } = fakeReqRes(ip);
    limiter(req, res, next);
  }
  assert.equal(nextCalls, 3);

  const { req, res, getStatus, getBody } = fakeReqRes(ip);
  limiter(req, res, next);
  assert.equal(nextCalls, 3);
  assert.equal(getStatus(), 429);
  assert.equal(getBody().error.code, "RATE_LIMITED");

  limiter.stop();
});

test("createRateLimiter tracks separate IPs independently", () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
  let nextCalls = 0;
  const next = () => nextCalls++;

  const a = fakeReqRes("1.1.1.1");
  limiter(a.req, a.res, next);
  const b = fakeReqRes("2.2.2.2");
  limiter(b.req, b.res, next);

  assert.equal(nextCalls, 2);
  assert.equal(a.getStatus(), null);
  assert.equal(b.getStatus(), null);

  limiter.stop();
});
