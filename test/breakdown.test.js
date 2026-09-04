const test = require("node:test");
const assert = require("node:assert/strict");

const { pick, riskBand } = require("../assets/breakdown.js");

test("pick returns the first present key", () => {
  assert.equal(pick({ a: 1, b: 2 }, "a", "b"), 1);
  assert.equal(pick({ b: 2 }, "a", "b"), 2);
});

test("pick treats null and undefined as absent", () => {
  assert.equal(pick({ a: null, b: 7 }, "a", "b"), 7);
  assert.equal(pick({ a: undefined, b: 7 }, "a", "b"), 7);
  assert.equal(pick({}, "a"), undefined);
});

test("pick tolerates non-objects", () => {
  assert.equal(pick(null, "a"), undefined);
  assert.equal(pick(undefined, "a"), undefined);
  assert.equal(pick("string", "a"), undefined);
});

test("pick keeps falsy-but-present values", () => {
  assert.equal(pick({ a: 0 }, "a"), 0);
  assert.equal(pick({ a: false }, "a"), false);
});

test("riskBand maps scores to Twilio's documented bands", () => {
  assert.equal(riskBand(0), "Low");
  assert.equal(riskBand(59), "Low");
  assert.equal(riskBand(60), "Mild");
  assert.equal(riskBand(74), "Mild");
  assert.equal(riskBand(75), "Moderate");
  assert.equal(riskBand(89), "Moderate");
  assert.equal(riskBand(90), "High");
  assert.equal(riskBand(100), "High");
});

test("riskBand rejects missing and out-of-range scores", () => {
  assert.equal(riskBand(null), null);
  assert.equal(riskBand(undefined), null);
  assert.equal(riskBand(""), null);
  assert.equal(riskBand("not a number"), null);
  assert.equal(riskBand(NaN), null);
  assert.equal(riskBand(-1), null);
  assert.equal(riskBand(101), null);
});

test("riskBand accepts numeric strings, since JSON is not always typed", () => {
  assert.equal(riskBand("44"), "Low");
  assert.equal(riskBand("95"), "High");
});
