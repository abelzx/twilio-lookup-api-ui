const test = require("node:test");
const assert = require("node:assert/strict");

const {
  pick,
  riskBand,
  DIMENSIONS,
  computeBreakdown,
} = require("../assets/breakdown.js");

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

function dim(id) {
  const d = DIMENSIONS.find((x) => x.id === id);
  assert.ok(d, `no dimension registered with id ${id}`);
  return d;
}

test("registry exposes the four expected dimensions in order", () => {
  assert.deepEqual(DIMENSIONS.map((d) => d.id), [
    "lineStatus",
    "lineType",
    "riskBand",
    "country",
  ]);
});

test("lineStatus extractor normalises casing and reads both key spellings", () => {
  const d = dim("lineStatus");
  assert.equal(d.extract({ line_status: { status: "reachable" } }), "Reachable");
  assert.equal(d.extract({ lineStatus: { status: "INACTIVE" } }), "Inactive");
  assert.equal(d.extract({ lineStatus: { status: "Unreachable" } }), "Unreachable");
  assert.equal(d.extract({ lineStatus: null }), null);
  assert.equal(d.extract({}), null);
  // a package that errored carries error_code and no status
  assert.equal(d.extract({ lineStatus: { error_code: 60600 } }), null);
});

test("lineType extractor preserves the API's camelCase enum values", () => {
  const d = dim("lineType");
  assert.equal(d.extract({ line_type_intelligence: { type: "mobile" } }), "mobile");
  assert.equal(
    d.extract({ lineTypeIntelligence: { type: "nonFixedVoip" } }),
    "nonFixedVoip"
  );
  assert.equal(d.extract({ lineTypeIntelligence: { error_code: 60600 } }), null);
  assert.equal(d.extract({}), null);
});

test("riskBand extractor reads either score spelling", () => {
  const d = dim("riskBand");
  assert.equal(
    d.extract({ sms_pumping_risk: { sms_pumping_risk_score: 44 } }),
    "Low"
  );
  assert.equal(
    d.extract({ smsPumpingRisk: { smsPumpingRiskScore: 95 } }),
    "High"
  );
  // score 0 is a real value, not "missing"
  assert.equal(d.extract({ smsPumpingRisk: { sms_pumping_risk_score: 0 } }), "Low");
  assert.equal(d.extract({ smsPumpingRisk: { error_code: 60600 } }), null);
  assert.equal(d.extract({}), null);
});

test("country extractor upper-cases and reads both spellings", () => {
  const d = dim("country");
  assert.equal(d.extract({ country_code: "gb" }), "GB");
  assert.equal(d.extract({ countryCode: "US" }), "US");
  assert.equal(d.extract({}), null);
});

test("computeBreakdown counts run-level successes and errors", () => {
  const out = computeBreakdown([
    { input: "+1", ok: true, data: { countryCode: "US" } },
    { input: "+2", ok: true, data: { countryCode: "US" } },
    { input: "bad", ok: false, error: "invalid", code: 60200 },
  ]);
  assert.equal(out.total, 3);
  assert.equal(out.okCount, 2);
  assert.equal(out.errorCount, 1);
});

test("computeBreakdown uses a per-dimension denominator, not the run total", () => {
  // 4 numbers: all have a country, only 2 have a line status.
  const out = computeBreakdown([
    { ok: true, data: { countryCode: "US", lineStatus: { status: "reachable" } } },
    { ok: true, data: { countryCode: "US", lineStatus: { status: "inactive" } } },
    { ok: true, data: { countryCode: "GB", lineStatus: null } },
    { ok: true, data: { countryCode: "GB", lineStatus: { error_code: 60600 } } },
  ]);

  const status = out.dimensions.find((d) => d.id === "lineStatus");
  assert.equal(status.withData, 2);
  assert.equal(status.noData, 2);
  // 1 of 2 assessed numbers is Inactive -> 50%, NOT 25% of the run
  const inactive = status.categories.find((c) => c.label === "Inactive");
  assert.equal(inactive.count, 1);
  assert.equal(inactive.pct, 50);

  const country = out.dimensions.find((d) => d.id === "country");
  assert.equal(country.withData, 4);
  assert.equal(country.noData, 0);
});

test("computeBreakdown omits dimensions with no data at all", () => {
  const out = computeBreakdown([{ ok: true, data: { countryCode: "US" } }]);
  assert.deepEqual(out.dimensions.map((d) => d.id), ["country"]);
});

test("computeBreakdown excludes failed rows from every denominator", () => {
  const out = computeBreakdown([
    { ok: true, data: { countryCode: "US" } },
    { ok: false, error: "boom" },
  ]);
  const country = out.dimensions.find((d) => d.id === "country");
  assert.equal(country.withData, 1);
  assert.equal(country.noData, 1);
  assert.equal(country.categories[0].pct, 100);
});

test("computeBreakdown handles empty and non-array input", () => {
  for (const input of [[], null, undefined, "nope"]) {
    const out = computeBreakdown(input);
    assert.equal(out.total, 0);
    assert.deepEqual(out.dimensions, []);
  }
});

test("computeBreakdown survives a row whose extractor throws", () => {
  const out = computeBreakdown([
    { ok: true, data: { get countryCode() { throw new Error("boom"); } } },
    { ok: true, data: { countryCode: "US" } },
  ]);
  const country = out.dimensions.find((d) => d.id === "country");
  assert.equal(country.withData, 1);
});
