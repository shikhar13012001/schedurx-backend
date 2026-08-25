const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { createEmailClient } = require("../../src/services/email-service");

describe("createEmailClient", () => {
  test("returns null when Gmail credentials aren't configured", () => {
    assert.equal(createEmailClient({}), null);
    assert.equal(createEmailClient({ gmailUser: "x@gmail.com" }), null);
    assert.equal(createEmailClient({ gmailAppPassword: "abcd efgh ijkl mnop" }), null);
  });

  test("returns a client with sendAlert when both credentials are set", () => {
    const client = createEmailClient({ gmailUser: "alerts@gmail.com", gmailAppPassword: "abcd efgh ijkl mnop" });
    assert.ok(client);
    assert.equal(typeof client.sendAlert, "function");
  });
});
