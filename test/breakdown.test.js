const test = require("node:test");
const assert = require("node:assert/strict");

const { pick } = require("../assets/breakdown.js");

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
