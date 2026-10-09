const test = require("node:test");
const assert = require("node:assert/strict");

const { summarizeEmailResult, emailVerdict } = require("../assets/email.js");

function result(overrides = {}) {
  return {
    email: "a@example.com",
    verdict: "Valid",
    score: 0.97321,
    checks: {
      domain: {
        has_valid_address_syntax: true,
        has_mx_or_a_record: true,
        is_suspected_disposable_address: false,
      },
      local_part: { is_suspected_role_address: false },
      additional: { has_known_bounces: false, has_suspected_bounces: false },
    },
    ...overrides,
  };
}

test("a clean address shows only its score", () => {
  assert.equal(summarizeEmailResult(result()), "0.97");
});

test("every raised flag is listed in a fixed order, then the suggestion", () => {
  const data = result({
    score: 0.1,
    suggestion: "gmail.com",
    checks: {
      domain: {
        has_valid_address_syntax: false,
        has_mx_or_a_record: false,
        is_suspected_disposable_address: true,
      },
      local_part: { is_suspected_role_address: true },
      additional: { has_known_bounces: true, has_suspected_bounces: true },
    },
  });
  assert.equal(
    summarizeEmailResult(data),
    "0.10 · disposable · role address · no MX/A record · bad syntax · known bounces · suspected bounces · did you mean gmail.com?"
  );
});

test("missing checks are not reported as failures", () => {
  assert.equal(summarizeEmailResult({ verdict: "Risky", score: 0.5 }), "0.50");
  assert.equal(summarizeEmailResult(null), "—");
});

test("emailVerdict maps SendGrid verdicts and request errors to labels", () => {
  assert.deepEqual(emailVerdict({ ok: true, data: { verdict: "Valid" } }), {
    label: "Valid",
    className: "verdict--valid",
  });
  assert.deepEqual(emailVerdict({ ok: true, data: { verdict: "Risky" } }), {
    label: "Risky",
    className: "verdict--risky",
  });
  assert.deepEqual(emailVerdict({ ok: true, data: { verdict: "Invalid" } }), {
    label: "Invalid",
    className: "verdict--invalid",
  });
  assert.deepEqual(emailVerdict({ ok: false, error: "x" }), {
    label: "Error",
    className: "verdict--invalid",
  });
  assert.deepEqual(emailVerdict({ ok: true, data: {} }), { label: "—", className: "" });
});
