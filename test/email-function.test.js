const test = require("node:test");
const assert = require("node:assert/strict");

/** The Functions runtime provides Twilio.Response as a global. */
class FakeResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.body = undefined;
  }
  appendHeader(key, value) {
    this.headers[key] = value;
  }
  setStatusCode(code) {
    this.statusCode = code;
  }
  setBody(body) {
    this.body = body;
  }
}
global.Twilio = { Response: FakeResponse };

const { handler } = require("../functions/email.js");

const KEY_REJECTED =
  "SendGrid rejected the API key. It needs the Email Address Validation scope, which is available on Email API Pro and Premier plans only.";

function invoke(event) {
  return new Promise((resolve, reject) => {
    handler({}, event, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

/** Replaces global fetch for one test. `respond(email, attempt)` returns [status, body]. */
function stubSendgrid(t, respond) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const attempt = calls.filter((c) => c.body.email === body.email).length;
    calls.push({ url, init, body });
    const [status, payload] = await respond(body.email, attempt);
    return new Response(
      typeof payload === "string" ? payload : JSON.stringify(payload),
      { status }
    );
  };
  t.after(() => {
    global.fetch = original;
  });
  return calls;
}

function validResult(email) {
  const [local, host] = email.split("@");
  return {
    result: {
      email,
      verdict: "Valid",
      score: 0.97,
      local,
      host,
      checks: {
        domain: {
          has_valid_address_syntax: true,
          has_mx_or_a_record: true,
          is_suspected_disposable_address: false,
        },
        local_part: { is_suspected_role_address: false },
        additional: { has_known_bounces: false, has_suspected_bounces: false },
      },
      ip_address: "192.0.2.1",
    },
  };
}

test("splits, trims and de-duplicates, one request per address", async (t) => {
  const calls = stubSendgrid(t, (email) => [200, validResult(email)]);
  const res = await invoke({
    apiKey: "SG.test",
    emails: " a@example.com \nb@example.com,a@example.com",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    res.body.results.map((r) => r.input),
    ["a@example.com", "b@example.com"]
  );
  assert.deepEqual(res.body.results[0], {
    input: "a@example.com",
    ok: true,
    data: validResult("a@example.com").result,
  });
});

test("sends the key as a bearer token and passes source through", async (t) => {
  const calls = stubSendgrid(t, (email) => [200, validResult(email)]);
  await invoke({ apiKey: " SG.test ", emails: ["a@example.com"], source: "signup" });
  assert.equal(calls[0].url, "https://api.sendgrid.com/v3/validations/email");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer SG.test");
  assert.deepEqual(calls[0].body, { email: "a@example.com", source: "signup" });
});

test("omits source when none is given", async (t) => {
  const calls = stubSendgrid(t, (email) => [200, validResult(email)]);
  await invoke({ apiKey: "SG.test", emails: ["a@example.com"] });
  assert.deepEqual(calls[0].body, { email: "a@example.com" });
});

test("400 for an empty list, a missing key, or a bad source", async (t) => {
  const calls = stubSendgrid(t, (email) => [200, validResult(email)]);

  const empty = await invoke({ apiKey: "SG.test", emails: " \n, " });
  assert.equal(empty.statusCode, 400);
  assert.deepEqual(empty.body, { error: "Provide at least one email address." });

  const noKey = await invoke({ emails: ["a@example.com"] });
  assert.equal(noKey.statusCode, 400);
  assert.deepEqual(noKey.body, { error: "A SendGrid API key is required." });

  const badSource = await invoke({
    apiKey: "SG.test",
    emails: ["a@example.com"],
    source: "sign-up!",
  });
  assert.equal(badSource.statusCode, 400);
  assert.match(badSource.body.error, /letters, digits and spaces/);

  assert.equal(calls.length, 0);
});

test("a per-address error does not fail the batch", async (t) => {
  stubSendgrid(t, (email) =>
    email === "bad@"
      ? [400, { errors: [{ field: "email", message: "invalid email" }] }]
      : [200, validResult(email)]
  );
  const res = await invoke({ apiKey: "SG.test", emails: ["a@example.com", "bad@"] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results[0].ok, true);
  assert.deepEqual(res.body.results[1], {
    input: "bad@",
    ok: false,
    error: "invalid email",
    code: 400,
  });
});

test("a 401 from SendGrid becomes HTTP 401 with SendGrid's message appended", async (t) => {
  stubSendgrid(t, () => [401, { errors: [{ message: "authorization required" }] }]);
  const res = await invoke({ apiKey: "SG.bad", emails: ["a@example.com"] });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, `${KEY_REJECTED} SendGrid said: authorization required`);
});

test("a 403 with no SendGrid message becomes HTTP 401 with the plain message", async (t) => {
  stubSendgrid(t, () => [403, ""]);
  const res = await invoke({ apiKey: "SG.bad", emails: ["a@example.com"] });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: KEY_REJECTED });
});

test("a 429 then a 200 succeeds after one retry", async (t) => {
  const calls = stubSendgrid(t, (email, attempt) =>
    attempt === 0 ? [429, { errors: [{ message: "too many requests" }] }] : [200, validResult(email)]
  );
  const res = await invoke({ apiKey: "SG.test", emails: ["a@example.com"] });
  assert.equal(calls.length, 2);
  assert.equal(res.body.results[0].ok, true);
});

test("a 429 that persists is retried twice, then reported", async (t) => {
  const calls = stubSendgrid(t, () => [429, { errors: [{ message: "too many requests" }] }]);
  const res = await invoke({ apiKey: "SG.test", emails: ["a@example.com"] });
  assert.equal(calls.length, 3);
  assert.deepEqual(res.body.results[0], {
    input: "a@example.com",
    ok: false,
    error: "too many requests",
    code: 429,
  });
});

test("an upstream timeout is reported on that row only", async (t) => {
  stubSendgrid(t, (email) => {
    if (email === "slow@example.com") {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }
    return [200, validResult(email)];
  });
  const res = await invoke({
    apiKey: "SG.test",
    emails: ["slow@example.com", "a@example.com"],
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.results[0], {
    input: "slow@example.com",
    ok: false,
    error: "SendGrid did not respond in time.",
  });
  assert.equal(res.body.results[1].ok, true);
});
