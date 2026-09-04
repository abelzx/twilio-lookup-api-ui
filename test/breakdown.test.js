const test = require("node:test");
const assert = require("node:assert/strict");

const {
  pick,
  riskBand,
  DIMENSIONS,
  computeBreakdown,
  MAX_SLICES,
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

test("registry exposes the five expected dimensions in order", () => {
  // carrier sits next to lineType because both come from the
  // line_type_intelligence package.
  assert.deepEqual(DIMENSIONS.map((d) => d.id), [
    "lineStatus",
    "lineType",
    "carrier",
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

/** Build results where each line status value appears `n` times. */
function statusResults(spec) {
  const out = [];
  for (const [status, n] of Object.entries(spec)) {
    for (let i = 0; i < n; i++) {
      out.push({ ok: true, data: { lineStatus: { status } } });
    }
  }
  return out;
}

function statusCats(spec) {
  const out = computeBreakdown(statusResults(spec));
  return out.dimensions.find((d) => d.id === "lineStatus").categories;
}

test("ordinal categories keep their fixed order regardless of count", () => {
  // Inactive is the largest, but order is severity, not size.
  const cats = statusCats({ inactive: 100, reachable: 5, active: 1 });
  assert.deepEqual(cats.map((c) => c.label), ["Reachable", "Active", "Inactive"]);
});

test("ordinal categories omit values absent from the run", () => {
  const cats = statusCats({ reachable: 3, inactive: 2 });
  assert.deepEqual(cats.map((c) => c.label), ["Reachable", "Inactive"]);
});

test("ordinal ramp size matches the number of non-neutral categories", () => {
  const cats = statusCats({ reachable: 1, active: 1, unreachable: 1, inactive: 1 });
  assert.deepEqual(cats.map((c) => c.color), [
    "#86b6ef",
    "#2a78d6",
    "#1c5cab",
    "#104281",
  ]);
});

test("Unknown takes the neutral grey and sorts last", () => {
  const cats = statusCats({ reachable: 5, unknown: 2, inactive: 1 });
  assert.deepEqual(cats.map((c) => c.label), ["Reachable", "Inactive", "Unknown"]);
  assert.equal(cats[cats.length - 1].color, "#8891AA");
  // the two ramped categories share a 2-step ramp
  assert.deepEqual(cats.slice(0, 2).map((c) => c.color), ["#86b6ef", "#104281"]);
});

test("an unrecognised ordinal value is treated as neutral, not given a ramp step", () => {
  const cats = statusCats({ reachable: 3, teleported: 1 });
  const odd = cats.find((c) => c.label === "Teleported");
  assert.ok(odd, "unknown value should still appear as its own category");
  assert.equal(odd.color, "#8891AA");
  assert.equal(cats[cats.length - 1].label, "Teleported");
});

test("ordinal categories carry status roles for the notable states", () => {
  const cats = statusCats({ reachable: 1, unreachable: 1, inactive: 1 });
  const byLabel = Object.fromEntries(cats.map((c) => [c.label, c.statusRole]));
  assert.equal(byLabel.Reachable, null);
  assert.equal(byLabel.Unreachable, "warning");
  assert.equal(byLabel.Inactive, "critical");
});

test("an all-unrecognised ordinal run greys everything and sorts alphabetically", () => {
  // No known values at all: exercises the ramped.length === 0 clamp, and the
  // localeCompare sort that every other test leaves unrun with only one value.
  const cats = statusCats({ zebra: 1, apple: 2 });
  assert.deepEqual(cats.map((c) => c.label), ["Apple", "Zebra"]);
  assert.deepEqual(cats.map((c) => c.color), ["#8891AA", "#8891AA"]);
  assert.equal(cats.find((c) => c.label === "Apple").count, 2);
});

test("riskBand dimension ramps its four bands and carries status roles", () => {
  // Counts are deliberately not in band order — Mild is largest, Low smallest —
  // so this also proves the fixed order isn't incidentally count order.
  const byScore = { 10: 1, 65: 4, 80: 2, 95: 3 };
  const results = [];
  for (const [score, n] of Object.entries(byScore)) {
    for (let i = 0; i < n; i++) {
      results.push({
        ok: true,
        data: { smsPumpingRisk: { sms_pumping_risk_score: Number(score) } },
      });
    }
  }
  const cats = computeBreakdown(results).dimensions.find(
    (d) => d.id === "riskBand"
  ).categories;

  assert.deepEqual(cats.map((c) => c.label), ["Low", "Mild", "Moderate", "High"]);
  assert.deepEqual(cats.map((c) => c.color), [
    "#86b6ef",
    "#2a78d6",
    "#1c5cab",
    "#104281",
  ]);
  const byLabel = Object.fromEntries(cats.map((c) => [c.label, c.statusRole]));
  assert.equal(byLabel.Low, null);
  assert.equal(byLabel.Mild, null);
  assert.equal(byLabel.Moderate, "warning");
  assert.equal(byLabel.High, "critical");
});

/** Build results where each line type appears `n` times. */
function typeResults(spec) {
  const out = [];
  for (const [type, n] of Object.entries(spec)) {
    for (let i = 0; i < n; i++) {
      out.push({ ok: true, data: { lineTypeIntelligence: { type } } });
    }
  }
  return out;
}

function typeCats(spec) {
  const out = computeBreakdown(typeResults(spec));
  return out.dimensions.find((d) => d.id === "lineType").categories;
}

test("nominal slices are ordered by count, descending", () => {
  const cats = typeCats({ landline: 10, mobile: 50, tollFree: 30 });
  assert.deepEqual(cats.map((c) => c.label), ["mobile", "tollFree", "landline"]);
});

test("nominal hues follow stable key order, not count rank", () => {
  // mobile is first in the canonical list, so it takes slot 1 in both runs
  // even though its rank differs.
  const busy = typeCats({ mobile: 50, landline: 10 });
  const quiet = typeCats({ mobile: 5, landline: 90 });
  const hue = (cats, label) => cats.find((c) => c.label === label).color;

  assert.equal(hue(busy, "mobile"), "#2a78d6");
  assert.equal(hue(quiet, "mobile"), "#2a78d6");
  assert.equal(hue(busy, "landline"), "#eb6834");
  assert.equal(hue(quiet, "landline"), "#eb6834");
  // ...while slice order still follows count
  assert.equal(quiet[0].label, "landline");
});

test("exactly six categories are all shown, each with its own hue", () => {
  const cats = typeCats({
    mobile: 6, landline: 5, fixedVoip: 4,
    nonFixedVoip: 3, tollFree: 2, premium: 1,
  });
  assert.equal(cats.length, 6);
  assert.ok(!cats.some((c) => c.label.startsWith("Other")));
  assert.deepEqual(cats.map((c) => c.color), [
    "#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300",
  ]);
});

test("more than six categories fold the tail into Other", () => {
  const cats = typeCats({
    mobile: 100, landline: 50, fixedVoip: 25, nonFixedVoip: 12,
    tollFree: 6, premium: 3, sharedCost: 2, pager: 1,
  });
  assert.equal(cats.length, MAX_SLICES);
  const other = cats[cats.length - 1];
  // 8 categories: top 5 kept, remaining 3 folded
  assert.equal(other.label, "Other (3)");
  assert.equal(other.count, 6); // premium 3 + sharedCost 2 + pager 1
  assert.equal(other.color, "#8891AA");
  assert.deepEqual(other.folded.map((f) => f.label), [
    "premium", "sharedCost", "pager",
  ]);
});

test("Other always sorts last even when it outweighs a kept category", () => {
  // 7 categories, so the 2 smallest fold. By count the kept five are
  // mobile 100, premium 20, sharedCost 20, then landline 2 and fixedVoip 2
  // (ties broken by canonical key order). nonFixedVoip and tollFree fold.
  const cats = typeCats({
    mobile: 100, landline: 2, fixedVoip: 2, nonFixedVoip: 2, tollFree: 2,
    premium: 20, sharedCost: 20,
  });
  const other = cats[cats.length - 1];
  assert.equal(other.label, "Other (2)");
  assert.equal(other.count, 4); // nonFixedVoip 2 + tollFree 2
  // Other (4) is larger than the kept fixedVoip (2) yet still sorts last.
  assert.ok(other.count > cats[cats.length - 2].count);
});

test("count ties are broken by stable key order, not insertion order", () => {
  const a = typeCats({ landline: 5, mobile: 5 });
  const b = typeCats({ mobile: 5, landline: 5 });
  assert.deepEqual(a.map((c) => c.label), ["mobile", "landline"]);
  assert.deepEqual(b.map((c) => c.label), ["mobile", "landline"]);
});

test("country hues follow count rank, since alphabetical order means nothing", () => {
  const out = computeBreakdown([
    { ok: true, data: { countryCode: "US" } },
    { ok: true, data: { countryCode: "US" } },
    { ok: true, data: { countryCode: "AU" } },
  ]);
  const cats = out.dimensions.find((d) => d.id === "country").categories;
  // slice order by count: US then AU
  assert.deepEqual(cats.map((c) => c.label), ["US", "AU"]);
  // hue by count rank, NOT alphabetical — the dominant slice gets slot 1 so the
  // biggest wedge is the strongest colour rather than whatever its initial
  // letter dictated.
  assert.equal(cats.find((c) => c.label === "US").color, "#2a78d6");
  assert.equal(cats.find((c) => c.label === "AU").color, "#eb6834");
});

test("percentages sum to about 100 and are not fudged", () => {
  const cats = typeCats({ mobile: 1, landline: 1, tollFree: 1 });
  const sum = cats.reduce((s, c) => s + c.pct, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9, `expected ~100, got ${sum}`);
  assert.ok(Math.abs(cats[0].pct - 33.3333333) < 0.001);
});

test("Other has the same shape as a regular category", () => {
  // The renderer iterates categories uniformly, but Other is hand-built rather
  // than going through makeCategory — so the two shapes must stay in lockstep.
  const cats = typeCats({
    mobile: 100, landline: 50, fixedVoip: 25, nonFixedVoip: 12,
    tollFree: 6, premium: 3, sharedCost: 2, pager: 1,
  });
  const other = cats[cats.length - 1];
  const regular = cats[0];
  assert.equal(other.label, "Other (3)", "fixture should be producing a fold");
  assert.deepEqual(Object.keys(other).sort(), Object.keys(regular).sort());
});

test("lineType keeps entity-stable hues while country uses count rank", () => {
  // lineType has a canonical order, so mobile is blue even when it is smallest.
  const types = typeCats({ tollFree: 100, mobile: 1 });
  assert.equal(types.find((c) => c.label === "mobile").color, "#2a78d6");
  assert.equal(types[0].label, "tollFree", "slice order still follows count");

  // country has none, so the largest takes slot 1 instead.
  const out = computeBreakdown([
    ...Array.from({ length: 100 }, () => ({ ok: true, data: { countryCode: "ZW" } })),
    { ok: true, data: { countryCode: "AU" } },
  ]);
  const countries = out.dimensions.find((d) => d.id === "country").categories;
  assert.equal(countries.find((c) => c.label === "ZW").color, "#2a78d6");
  assert.equal(countries.find((c) => c.label === "AU").color, "#eb6834");
});

/** Build results where each carrier name appears `n` times. */
function carrierResults(spec) {
  const out = [];
  for (const [carrier_name, n] of Object.entries(spec)) {
    for (let i = 0; i < n; i++) {
      out.push({
        ok: true,
        data: { lineTypeIntelligence: { type: "mobile", carrier_name } },
      });
    }
  }
  return out;
}

function carrierCats(spec) {
  const out = computeBreakdown(carrierResults(spec));
  return out.dimensions.find((d) => d.id === "carrier").categories;
}

test("carrier extractor reads both key spellings", () => {
  const d = dim("carrier");
  assert.equal(
    d.extract({ line_type_intelligence: { carrier_name: "T-Mobile USA, Inc." } }),
    "T-Mobile USA, Inc."
  );
  assert.equal(
    d.extract({ lineTypeIntelligence: { carrierName: "Twilio - SMS/MMS-SVR" } }),
    "Twilio - SMS/MMS-SVR"
  );
  assert.equal(d.extract({}), null);
  assert.equal(d.extract({ lineTypeIntelligence: { error_code: 60601 } }), null);
});

test("carrier is null for the line types Twilio returns no carrier for", () => {
  // Per Twilio's docs, carrier_name is null for tollFree, premium, sharedCost,
  // uan, voicemail, pager, personal and unknown — 8 of the 12 types. So the
  // carrier card's denominator is legitimately smaller than line type's.
  const d = dim("carrier");
  assert.equal(
    d.extract({ lineTypeIntelligence: { type: "tollFree", carrier_name: null } }),
    null
  );
  const out = computeBreakdown([
    { ok: true, data: { lineTypeIntelligence: { type: "mobile", carrier_name: "AT&T" } } },
    { ok: true, data: { lineTypeIntelligence: { type: "tollFree", carrier_name: null } } },
    { ok: true, data: { lineTypeIntelligence: { type: "pager", carrier_name: null } } },
  ]);
  const lineType = out.dimensions.find((d) => d.id === "lineType");
  const carrier = out.dimensions.find((d) => d.id === "carrier");
  assert.equal(lineType.withData, 3, "all three have a line type");
  assert.equal(carrier.withData, 1, "only the mobile one has a carrier");
  assert.equal(carrier.noData, 2);
  assert.equal(carrier.categories[0].pct, 100, "100% of carriers found, not 33%");
});

test("carrier trims whitespace and treats blank as no data", () => {
  const d = dim("carrier");
  assert.equal(d.extract({ lineTypeIntelligence: { carrier_name: "  AT&T  " } }), "AT&T");
  assert.equal(d.extract({ lineTypeIntelligence: { carrier_name: "   " } }), null);
  assert.equal(d.extract({ lineTypeIntelligence: { carrier_name: "" } }), null);
});

test("carrier hues follow count rank, like country", () => {
  // Free-text names have no canonical order, so the dominant carrier should take
  // slot 1 rather than whatever its initial letter dictates.
  const cats = carrierCats({ "Zed Telecom": 100, "Acme Mobile": 5 });
  assert.deepEqual(cats.map((c) => c.label), ["Zed Telecom", "Acme Mobile"]);
  assert.equal(cats.find((c) => c.label === "Zed Telecom").color, "#2a78d6");
  assert.equal(cats.find((c) => c.label === "Acme Mobile").color, "#eb6834");
});

test("high-cardinality carriers fold into Other with every member kept", () => {
  // A realistic global run has far more carriers than slices. Top 5 survive; the
  // rest fold, and the folded list keeps all of them for the tooltip/CSV.
  const spec = {};
  for (let i = 0; i < 40; i++) spec[`Carrier ${String(i).padStart(2, "0")}`] = 40 - i;
  const cats = carrierCats(spec);
  assert.equal(cats.length, MAX_SLICES, "still capped at the palette size");
  const other = cats[cats.length - 1];
  assert.equal(other.label, "Other (35)", "40 carriers minus the 5 kept");
  assert.equal(other.color, "#8891AA");
  assert.equal(other.folded.length, 35, "no folded carrier is dropped");
  // folded stays count-descending
  const counts = other.folded.map((f) => f.count);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  // and Other's count is the sum of its members
  assert.equal(other.count, counts.reduce((s, c) => s + c, 0));
});
