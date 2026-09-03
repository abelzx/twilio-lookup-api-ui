# Results Breakdown Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible Breakdown block to the top of the Results panel showing one donut chart per Lookup data package the run actually returned.

**Architecture:** One new browser script, `assets/breakdown.js`, holding a dimension registry, a pure aggregator, and an SVG renderer. `assets/app.js` calls it at the two points where it already handles results. Aggregation is a pure function of the results array, exported via a `module.exports` sniff so `node:test` can require it without a DOM.

**Tech Stack:** Vanilla ES2020 browser JS (no bundler, no framework), inline SVG with `pathLength="100"`, CSS custom properties already defined in `assets/styles.css`, `node:test` built into Node 22/24.

**Spec:** `docs/superpowers/specs/2026-09-03-results-breakdown-charts-design.md`

---

## Background the engineer needs

**What this app is.** A Twilio Serverless app. `functions/*.js` are server-side Twilio Functions; `assets/*` are static files served publicly at the service root (so `assets/app.js` is fetched as `/app.js`). There is no build step — scripts are plain `<script src>` tags with global functions. Follow that pattern; do not introduce ES modules, a bundler, or a framework.

**Where results come from.** `functions/lookup.js` returns `{ results, fetchParams }`, where each result is:

```js
{ input: "+14155552671", ok: true,  data: { /* Lookup v2 response */ } }
{ input: "garbage",      ok: false, error: "...", code: 60200 }
```

**The casing trap.** `functions/lookup.js:141` does `resource.toJSON()` on the Twilio SDK object. That yields **camelCase top-level keys** (`countryCode`, `lineTypeIntelligence`) but the nested package objects come straight from the API JSON and keep **snake_case** (`sms_pumping_risk_score`, `error_code`). `assets/app.js:685` already hedges this (`data.national_format || data.nationalFormat`). Every extractor in this plan reads both spellings. Do not "clean this up" by picking one.

**Colour values are not adjustable.** Every hex in this plan was run through a colourblind-safety validator against this app's surface. Changing one silently breaks a check. In particular: do **not** replace the blue ramp with a red/amber/green scheme — `#d03b3b` vs `#0ca30c` measures ΔE 4.1 under deuteranopia, i.e. indistinguishable. Status colour appears only as a dot beside a text label.

**Surface.** The block lives inside `.details`, whose background is `--surface-hover` (`#F9FAFB`). The 2px gaps between donut segments and the donut track are that same colour, so gaps read as gaps.

---

## File Structure

| File | Responsibility |
|---|---|
| `assets/breakdown.js` | **New.** Everything for this feature: `pick`/`riskBand` helpers, the `DIMENSIONS` registry, `computeBreakdown()` (pure), the SVG/legend renderer, `renderBreakdown()` / `clearBreakdown()`. Single responsibility: "the breakdown block". |
| `test/breakdown.test.js` | **New.** Tests the pure aggregator only. Rendering is verified by running the app. |
| `assets/index.html` | Add the `<details>` block inside the Results panel; add the `<script>` tag before `app.js`. |
| `assets/styles.css` | Add the `.breakdown` / `.bd-*` block at the end. |
| `assets/app.js` | Two call sites. No other changes. |
| `package.json` | Add `"test": "node --test"`. |
| `.github/workflows/ci.yml` | Widen the syntax-check glob; add an `npm test` step. |

`test/` sits outside `functions/` and `assets/`, so `twilio serverless:deploy` does not upload it.

---

## Task 1: Test harness and the `pick` helper

**Files:**
- Create: `assets/breakdown.js`
- Create: `test/breakdown.test.js`
- Modify: `package.json`

- [ ] **Step 1: Add the test script**

In `package.json`, add `test` as the first entry of `"scripts"`:

```json
  "scripts": {
    "test": "node --test",
    "dev": "twilio serverless:start",
```

- [ ] **Step 2: Write the failing test**

Create `test/breakdown.test.js`:

```js
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../assets/breakdown.js'`

- [ ] **Step 4: Write the minimal implementation**

Create `assets/breakdown.js`:

```js
/**
 * Results breakdown — one donut per Lookup data package the run returned.
 *
 * Aggregation (`computeBreakdown`) is a pure function of the results array and is
 * unit-tested; rendering touches only the container element it is handed.
 * See docs/superpowers/specs/2026-09-03-results-breakdown-charts-design.md
 */

/**
 * Lookup returns camelCase top-level keys but snake_case inside package objects
 * (see functions/lookup.js `toJSON()`), so every read hedges on both spellings.
 * Returns the first key that is present and non-null; `0` and `false` count as present.
 */
function pick(obj, ...names) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const name of names) {
    const v = obj[name];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/* Requireable from node:test while staying a plain browser script. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { pick };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 4 tests, 0 failures

- [ ] **Step 6: Commit**

```bash
git add package.json assets/breakdown.js test/breakdown.test.js
git commit -m "Add breakdown module skeleton with key-casing helper

Lookup's toJSON() mixes camelCase top-level keys with snake_case package
internals, so every field read hedges on both spellings rather than
assuming one."
```

---

## Task 2: Risk band bucketing

Twilio's published guidance (<https://www.twilio.com/docs/lookup/v2-api/sms-pumping-risk>) gives Low 0–60, Mild 60–75, Moderate 75–90, High 90–100. Boundaries are half-open so every score lands in exactly one band, with 100 inclusive at the top.

**Files:**
- Modify: `assets/breakdown.js`
- Modify: `test/breakdown.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/breakdown.test.js`:

```js
const { riskBand } = require("../assets/breakdown.js");

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
```

Update the require at the top of the file to pull both helpers — replace the existing `const { pick } = require(...)` line with:

```js
const { pick, riskBand } = require("../assets/breakdown.js");
```

and delete the standalone `const { riskBand } = ...` line you just added.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `riskBand is not a function`

- [ ] **Step 3: Write the minimal implementation**

In `assets/breakdown.js`, add after `pick`:

```js
/**
 * SMS pumping risk score (0-100) to a band, per Twilio's published guidance:
 * Low 0-60, Mild 60-75, Moderate 75-90, High 90-100.
 * https://www.twilio.com/docs/lookup/v2-api/sms-pumping-risk
 * Half-open boundaries, so 60 is Mild (not Low) and 100 is High.
 */
function riskBand(score) {
  if (score === null || score === undefined || score === "") return null;
  const s = Number(score);
  if (!Number.isFinite(s) || s < 0 || s > 100) return null;
  if (s < 60) return "Low";
  if (s < 75) return "Mild";
  if (s < 90) return "Moderate";
  return "High";
}
```

Update the export block:

```js
if (typeof module !== "undefined" && module.exports) {
  module.exports = { pick, riskBand };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 7 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add assets/breakdown.js test/breakdown.test.js
git commit -m "Bucket SMS pumping risk scores into Twilio's documented bands

Thresholds are Twilio's published guidance, not invented: Low 0-60,
Mild 60-75, Moderate 75-90, High 90-100. Half-open so 60 is Mild and
100 is High."
```

---

## Task 3: Dimension registry and extractors

**Files:**
- Modify: `assets/breakdown.js`
- Modify: `test/breakdown.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/breakdown.test.js`:

```js
const { DIMENSIONS } = require("../assets/breakdown.js");

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
```

Fold `DIMENSIONS` into the shared require at the top of the file and delete the standalone line:

```js
const { pick, riskBand, DIMENSIONS } = require("../assets/breakdown.js");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot read properties of undefined (reading 'map')`

- [ ] **Step 3: Write the minimal implementation**

In `assets/breakdown.js`, add after `riskBand`:

```js
/** "reachable" / "REACHABLE" -> "Reachable". Line status values only. */
function titleCase(s) {
  const str = String(s);
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * One entry per chartable field. A card renders only if at least one result has a
 * non-null value here, which is what makes the chart set follow the requested fields.
 *
 * scale "ordinal" -> fixed category order, single-hue ramp.
 * scale "nominal" -> ordered by count, categorical hues, folded past 6.
 * keyOrder        -> stable order used for hue assignment and tie-breaks
 *                    (null means alphabetical).
 */
const DIMENSIONS = [
  {
    id: "lineStatus",
    label: "Line status",
    scale: "ordinal",
    order: ["Reachable", "Active", "Unreachable", "Inactive", "Unknown"],
    neutral: ["Unknown"],
    statusRole: { Inactive: "critical", Unreachable: "warning" },
    extract(data) {
      const raw = pick(pick(data, "line_status", "lineStatus"), "status", "Status");
      return raw === undefined ? null : titleCase(raw);
    },
  },
  {
    id: "lineType",
    label: "Line type",
    scale: "nominal",
    keyOrder: [
      "mobile",
      "landline",
      "fixedVoip",
      "nonFixedVoip",
      "tollFree",
      "premium",
      "sharedCost",
      "uan",
      "voicemail",
      "pager",
      "unknown",
    ],
    extract(data) {
      const raw = pick(
        pick(data, "line_type_intelligence", "lineTypeIntelligence"),
        "type",
        "Type"
      );
      return raw === undefined ? null : String(raw);
    },
  },
  {
    id: "riskBand",
    label: "SMS pumping risk",
    scale: "ordinal",
    order: ["Low", "Mild", "Moderate", "High"],
    neutral: [],
    statusRole: { Moderate: "warning", High: "critical" },
    extract(data) {
      const raw = pick(
        pick(data, "sms_pumping_risk", "smsPumpingRisk"),
        "sms_pumping_risk_score",
        "smsPumpingRiskScore"
      );
      return raw === undefined ? null : riskBand(raw);
    },
  },
  {
    id: "country",
    label: "Country",
    scale: "nominal",
    keyOrder: null,
    extract(data) {
      const raw = pick(data, "country_code", "countryCode");
      return raw === undefined ? null : String(raw).toUpperCase();
    },
  },
];
```

Update the export block:

```js
if (typeof module !== "undefined" && module.exports) {
  module.exports = { pick, riskBand, titleCase, DIMENSIONS };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 12 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add assets/breakdown.js test/breakdown.test.js
git commit -m "Add dimension registry for the four chartable Lookup fields

Each entry knows how to extract its value and how it should be ordered
and coloured. A package that returned error_code instead of a value
yields null, so it counts as no-data for that dimension only."
```

---

## Task 4: Coverage counting and per-dimension denominators

The key correctness rule: **each dimension's percentages are over the numbers that returned that field**, not over the run total. A number on an unsupported network returns `lineStatus: null`, and counting it in the denominator would deflate every rate.

**Files:**
- Modify: `assets/breakdown.js`
- Modify: `test/breakdown.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/breakdown.test.js`:

```js
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
```

Add `computeBreakdown` to the shared require at the top:

```js
const {
  pick,
  riskBand,
  DIMENSIONS,
  computeBreakdown,
} = require("../assets/breakdown.js");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `computeBreakdown is not a function`

- [ ] **Step 3: Write the minimal implementation**

In `assets/breakdown.js`, add after `DIMENSIONS`:

```js
/**
 * Aggregate a results array into one summary per chartable dimension.
 * Pure: no DOM, no globals, no mutation of the input.
 *
 * Percentages are over `withData` (the numbers that returned that field), never
 * over the run total — a number on an unsupported network must not deflate the rate.
 */
function computeBreakdown(results) {
  const list = Array.isArray(results) ? results : [];
  const total = list.length;
  let okCount = 0;
  for (const r of list) if (r && r.ok) okCount++;

  const dimensions = [];
  for (const dim of DIMENSIONS) {
    const counts = new Map();
    let withData = 0;
    for (const r of list) {
      if (!r || !r.ok || !r.data) continue;
      let value = null;
      try {
        value = dim.extract(r.data);
      } catch {
        value = null; // a malformed row must not take down the panel
      }
      if (value === null || value === undefined || value === "") continue;
      withData++;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    if (withData === 0) continue;

    const categories =
      dim.scale === "ordinal"
        ? ordinalCategories(dim, counts)
        : nominalCategories(dim, counts);
    for (const c of categories) c.pct = (c.count / withData) * 100;

    dimensions.push({
      id: dim.id,
      label: dim.label,
      withData,
      noData: total - withData,
      categories,
    });
  }

  return { total, okCount, errorCount: total - okCount, dimensions };
}
```

Add temporary stubs immediately above `computeBreakdown` so this task runs green on its own; Tasks 5 and 6 replace them:

```js
function ordinalCategories(dim, counts) {
  return [...counts.entries()].map(([label, count]) => ({
    label,
    count,
    color: NEUTRAL,
    statusRole: null,
    folded: null,
  }));
}

function nominalCategories(dim, counts) {
  return ordinalCategories(dim, counts);
}
```

And the palette constants, near the top of the file after the doc comment:

```js
/**
 * Every colour below was validated against this app's surface (#F9FAFB, the
 * .details background) for colourblind separation and contrast. Do not adjust
 * them by eye. Notably a red/amber/green status scheme is NOT used: #d03b3b vs
 * #0ca30c measures OKLab dE 4.1 under deuteranopia, i.e. indistinguishable.
 */

/** Unknown / Other — "no position on the scale", so not a series colour. */
const NEUTRAL = "#8891AA";

/** Single-hue blue ramp for ordered categories, keyed by how many steps are needed. */
const ORDINAL_RAMPS = {
  1: ["#2a78d6"],
  2: ["#86b6ef", "#104281"],
  3: ["#86b6ef", "#2a78d6", "#104281"],
  4: ["#86b6ef", "#2a78d6", "#1c5cab", "#104281"],
  5: ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281"],
};

/** Categorical slots, assigned in this fixed order. Never cycled, never generated. */
const CATEGORICAL = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
];

/** Max donut slices before folding into "Other". */
const MAX_SLICES = 6;

/** Status dot colours. Always paired with a text label, never colour alone. */
const STATUS_COLORS = { warning: "#fab219", critical: "#d03b3b" };
```

Update the export block:

```js
if (typeof module !== "undefined" && module.exports) {
  module.exports = { pick, riskBand, titleCase, DIMENSIONS, computeBreakdown };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 18 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add assets/breakdown.js test/breakdown.test.js
git commit -m "Aggregate results per dimension with honest denominators

Each dimension's percentages divide by the numbers that returned that
field, not the run total, so numbers on unsupported networks do not
deflate every rate. Dimensions with no data are omitted entirely, which
is what makes the chart set follow the requested fields."
```

---

## Task 5: Ordinal category ordering and ramp assignment

Line status and risk have a meaningful order, so they are **not** sorted by count. `Unknown` (and any value Twilio adds that we don't know) takes the neutral grey rather than extending the ramp.

**Files:**
- Modify: `assets/breakdown.js`
- Modify: `test/breakdown.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/breakdown.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — the stub returns insertion order and all-neutral colours, so the ordering and colour assertions fail.

- [ ] **Step 3: Replace the ordinal stub with the real implementation**

In `assets/breakdown.js`, replace the `ordinalCategories` stub with:

```js
/**
 * Fixed severity order, ramped colours for the known non-neutral values.
 * Neutral values (Unknown) and any value Twilio adds that we don't recognise sort
 * last in grey — extending the ramp past 5 steps would break its lightness gaps.
 */
function ordinalCategories(dim, counts) {
  const neutralLabels = new Set(dim.neutral || []);
  const present = [...counts.keys()];
  const known = dim.order.filter((label) => counts.has(label));
  const unrecognised = present
    .filter((label) => !dim.order.includes(label))
    .sort((a, b) => a.localeCompare(b));

  const ramped = known.filter((label) => !neutralLabels.has(label));
  const greyed = [...known.filter((label) => neutralLabels.has(label)), ...unrecognised];

  const rampKey = Math.min(Math.max(ramped.length, 1), 5);
  const ramp = ORDINAL_RAMPS[rampKey];

  const out = ramped.map((label, i) =>
    makeCategory(dim, label, counts.get(label), ramp[i] || NEUTRAL)
  );
  for (const label of greyed) {
    out.push(makeCategory(dim, label, counts.get(label), NEUTRAL));
  }
  return out;
}

function makeCategory(dim, label, count, color) {
  return {
    label,
    count,
    color,
    statusRole: (dim.statusRole || {})[label] || null,
    folded: null,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 24 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add assets/breakdown.js test/breakdown.test.js
git commit -m "Order ordinal dimensions by severity and ramp their colours

Line status and risk keep a fixed best-to-worst order rather than
sorting by count, because the order carries meaning. Unknown and any
unrecognised value take neutral grey instead of a ramp step, since the
validated ramp only has gaps for five."
```

---

## Task 6: Nominal ordering, folding, and stable hues

Two separate orderings are in play, and conflating them is the bug to avoid:
- **slice order** = by count, descending (biggest first reads best)
- **hue assignment** = by stable key order (so a category's colour doesn't change when its count moves)

**Files:**
- Modify: `assets/breakdown.js`
- Modify: `test/breakdown.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/breakdown.test.js`:

```js
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

test("country falls back to alphabetical key order for hues", () => {
  const out = computeBreakdown([
    { ok: true, data: { countryCode: "US" } },
    { ok: true, data: { countryCode: "US" } },
    { ok: true, data: { countryCode: "AU" } },
  ]);
  const cats = out.dimensions.find((d) => d.id === "country").categories;
  // slice order by count: US then AU
  assert.deepEqual(cats.map((c) => c.label), ["US", "AU"]);
  // hue order alphabetical: AU takes slot 1
  assert.equal(cats.find((c) => c.label === "AU").color, "#2a78d6");
  assert.equal(cats.find((c) => c.label === "US").color, "#eb6834");
});

test("percentages sum to about 100 and are not fudged", () => {
  const cats = typeCats({ mobile: 1, landline: 1, tollFree: 1 });
  const sum = cats.reduce((s, c) => s + c.pct, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9, `expected ~100, got ${sum}`);
  assert.ok(Math.abs(cats[0].pct - 33.3333333) < 0.001);
});
```

Add `MAX_SLICES` to the shared require at the top:

```js
const {
  pick,
  riskBand,
  DIMENSIONS,
  computeBreakdown,
  MAX_SLICES,
} = require("../assets/breakdown.js");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — the stub does not sort, fold, or assign hues.

- [ ] **Step 3: Replace the nominal stub with the real implementation**

In `assets/breakdown.js`, replace the `nominalCategories` stub with:

```js
/**
 * Nominal dimensions: slices ordered by count (biggest first), but hues assigned by
 * stable key order so a category's colour never changes because its count moved.
 * Past MAX_SLICES categories, the tail folds into a grey "Other (n)" that sorts last.
 *
 * Stability caveat, by design: there are 6 slots and up to 11 line types, so the
 * mapping is stable for a given set of visible categories. Two runs whose visible
 * sets differ can assign the same category to different slots.
 */
function nominalCategories(dim, counts) {
  const keyRank = (label) => {
    if (!dim.keyOrder) return 0; // alphabetical fallback via the tie-break below
    const i = dim.keyOrder.indexOf(label);
    return i === -1 ? dim.keyOrder.length : i;
  };
  const byKey = (a, b) =>
    keyRank(a.label) - keyRank(b.label) || a.label.localeCompare(b.label);
  const byCount = (a, b) => b.count - a.count || byKey(a, b);

  const all = [...counts.entries()].map(([label, count]) => ({ label, count }));

  let visible = all;
  let folded = [];
  if (all.length > MAX_SLICES) {
    const ranked = [...all].sort(byCount);
    visible = ranked.slice(0, MAX_SLICES - 1);
    folded = ranked.slice(MAX_SLICES - 1);
  }

  // Hue by position in stable key order over the visible set.
  const colorFor = new Map();
  [...visible].sort(byKey).forEach((c, i) => {
    colorFor.set(c.label, CATEGORICAL[i] || NEUTRAL);
  });

  const out = [...visible]
    .sort(byCount)
    .map((c) => makeCategory(dim, c.label, c.count, colorFor.get(c.label)));

  if (folded.length > 0) {
    out.push({
      label: `Other (${folded.length})`,
      count: folded.reduce((sum, f) => sum + f.count, 0),
      color: NEUTRAL,
      statusRole: null,
      folded: [...folded].sort(byCount),
    });
  }
  return out;
}
```

Update the export block to expose `MAX_SLICES`:

```js
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    pick,
    riskBand,
    titleCase,
    DIMENSIONS,
    computeBreakdown,
    MAX_SLICES,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 32 tests, 0 failures

- [ ] **Step 5: Commit**

```bash
git add assets/breakdown.js test/breakdown.test.js
git commit -m "Order nominal slices by count while keeping hues stable

Slice order follows count so the biggest reads first, but hue assignment
follows a stable key order, so a category is not repainted when its rank
changes. Past six categories the tail folds into a grey Other that sorts
last and keeps its members for the tooltip."
```

---

## Task 7: Markup and styles

**Files:**
- Modify: `assets/index.html:185-206`
- Modify: `assets/styles.css` (append)

- [ ] **Step 1: Add the block to the Results panel**

In `assets/index.html`, inside `<section class="panel panel--results">`, insert between the closing `</div>` of `.results-header` and `<div class="table-wrap">`:

```html
            <details class="details breakdown" id="breakdownBlock" open hidden>
              <summary>Breakdown</summary>
              <p class="breakdown__coverage" id="breakdownCoverage" aria-live="polite"></p>
              <div class="breakdown__grid" id="breakdownGrid"></div>
            </details>
```

- [ ] **Step 2: Load the script before app.js**

At the bottom of `assets/index.html`, replace:

```html
    <script src="/app.js"></script>
```

with:

```html
    <script src="/breakdown.js"></script>
    <script src="/app.js"></script>
```

- [ ] **Step 3: Append the styles**

Add to the end of `assets/styles.css`:

```css
/* ---------------------------------------------------------------------------
   Results breakdown — one donut per returned Lookup data package.
   Colours live in breakdown.js (validated against the .details surface,
   #F9FAFB). Only layout and text tokens belong here.
   --------------------------------------------------------------------------- */
.breakdown {
  /* segment gaps and the donut track must match the surface behind them */
  --bd-surface: var(--surface-hover);
  --bd-track: #EDEFF4;
  position: relative;
}

.breakdown__coverage {
  margin: 0 0 0.9rem;
  font-size: 0.72rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.breakdown__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 1.25rem 1rem;
}

.bd-card {
  min-width: 0; /* let long legend labels ellipsize instead of widening the grid */
}

.bd-card__label {
  margin: 0 0 0.1rem;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text);
}

.bd-card__coverage {
  margin: 0 0 0.55rem;
  font-size: 0.7rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.bd-donut {
  display: block;
  width: 96px;
  height: 96px;
  margin: 0 auto 0.6rem;
}

.bd-donut__seg {
  transition: opacity 0.12s ease;
}

/* Emphasis: dim the others rather than recolouring the hovered one. */
.bd-card--focus .bd-donut__seg {
  opacity: 0.28;
}

.bd-card--focus .bd-donut__seg--on {
  opacity: 1;
}

.bd-donut__total {
  fill: var(--text);
  font-size: 6.2px;
  font-weight: 600;
}

.bd-donut__caption {
  fill: var(--text-muted);
  font-size: 2.7px;
  letter-spacing: 0.18px;
}

.bd-legend {
  margin: 0;
  padding: 0;
  list-style: none;
}

.bd-legend__row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.4rem;
  padding: 0.14rem 0.25rem;
  border-radius: 4px;
  font-size: 0.74rem;
}

.bd-legend__row:hover,
.bd-legend__row:focus-visible {
  background: var(--surface);
  outline: none;
}

.bd-legend__row:focus-visible {
  box-shadow: 0 0 0 2px var(--accent-light), 0 0 0 3px var(--accent);
}

.bd-legend__swatch {
  width: 9px;
  height: 9px;
  border-radius: 2px;
}

/* Status is carried by a dot AND the adjacent name — never colour alone. */
.bd-legend__status {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 0.3rem;
  vertical-align: 0.05em;
}

.bd-legend__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}

.bd-legend__value {
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.bd-legend__count {
  margin-left: 0.35rem;
  font-style: normal;
  color: var(--text-muted);
}

/* Single-category dimension: the number is the chart. */
.bd-tile {
  padding: 0.5rem 0 0.2rem;
}

.bd-tile__value {
  font-size: 1.45rem;
  font-weight: 600;
  line-height: 1.1;
  color: var(--text);
}

.bd-tile__name {
  font-size: 0.74rem;
  color: var(--text-secondary);
}

.bd-tooltip {
  position: absolute;
  z-index: 20;
  max-width: 15rem;
  padding: 0.4rem 0.55rem;
  border-radius: 6px;
  background: var(--twilio-navy);
  color: #fff;
  font-size: 0.72rem;
  line-height: 1.45;
  pointer-events: none;
  box-shadow: var(--shadow-md);
}

.bd-tooltip[hidden] {
  display: none;
}

.bd-tooltip__folded {
  margin: 0.25rem 0 0;
  padding: 0;
  list-style: none;
  color: rgba(255, 255, 255, 0.75);
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 4: Verify nothing renders yet and nothing broke**

Run: `npm run dev`
Open the printed localhost URL, sign in, run a lookup for one number.
Expected: results table works exactly as before; no Breakdown block visible (it is still `hidden` — nothing calls `renderBreakdown` yet).

- [ ] **Step 5: Commit**

```bash
git add assets/index.html assets/styles.css
git commit -m "Add breakdown block markup and styles

Collapsible block above the results table, matching the existing Raw
JSON details pattern. Cards use auto-fit minmax(210px) so they sit
two-up in the half-width column and one-up once the layout collapses."
```

---

## Task 8: Donut rendering

Geometry note: the circles carry `pathLength="100"`, so `stroke-dasharray` and `stroke-dashoffset` are in exact percentage units — no circumference arithmetic and no rounding drift. `stroke-dashoffset: 25 - cumulative` puts the first segment at 12 o'clock.

**Files:**
- Modify: `assets/breakdown.js`

- [ ] **Step 1: Add the rendering code**

In `assets/breakdown.js`, add after `nominalCategories` (before the export block):

```js
/* ---------------------------------------------------------------------------
   Rendering. Everything below touches the DOM and is verified by running the
   app, not by unit test. It is skipped entirely under node:test because
   `document` is only referenced inside these functions.
   --------------------------------------------------------------------------- */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Gap between segments, in percent-of-circumference units (~2px at 96px). */
const SEGMENT_GAP = 0.9;
/** Floor so a tiny slice still paints something rather than vanishing. */
const MIN_SEGMENT = 0.5;

function fmtCount(n) {
  return Number(n).toLocaleString();
}

/** One decimal, never fudged to force the column to total exactly 100. */
function fmtPct(pct) {
  return `${pct.toFixed(1)}%`;
}

function svgEl(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function donutAriaLabel(dimension) {
  const top = dimension.categories
    .slice(0, 3)
    .map((c) => `${c.label} ${fmtPct(c.pct)}`)
    .join(", ");
  return `${dimension.label}: ${top}. ${fmtCount(dimension.withData)} numbers with data.`;
}

function renderDonut(dimension) {
  const svg = svgEl("svg", {
    class: "bd-donut",
    viewBox: "0 0 42 42",
    role: "img",
    "aria-label": donutAriaLabel(dimension),
  });

  svg.appendChild(
    svgEl("circle", {
      cx: 21, cy: 21, r: 15.9, fill: "none",
      stroke: "var(--bd-track)", "stroke-width": 5,
    })
  );

  let cumulative = 0;
  dimension.categories.forEach((cat, i) => {
    const dash = Math.max(MIN_SEGMENT, cat.pct - SEGMENT_GAP);
    const offset = 25 - cumulative;
    const shared = {
      cx: 21, cy: 21, r: 15.9, fill: "none",
      pathLength: 100,
      "stroke-dasharray": `${dash} ${100 - dash}`,
      "stroke-dashoffset": offset,
    };

    // Transparent wide companion first: the hit target, ~24px effective.
    // pointer-events="stroke" is explicit so hit-testing does not depend on
    // whether a transparent stroke counts as "painted".
    svg.appendChild(
      svgEl("circle", {
        ...shared,
        stroke: "transparent",
        "stroke-width": 11,
        "pointer-events": "stroke",
        "data-index": i,
      })
    );

    svg.appendChild(
      svgEl("circle", {
        ...shared,
        stroke: cat.color,
        "stroke-width": 5,
        class: "bd-donut__seg",
        "data-index": i,
      })
    );

    cumulative += cat.pct;
  });

  const total = svgEl("text", {
    class: "bd-donut__total", x: 21, y: 20.4, "text-anchor": "middle",
  });
  total.textContent = fmtCount(dimension.withData);
  svg.appendChild(total);

  const caption = svgEl("text", {
    class: "bd-donut__caption", x: 21, y: 24.6, "text-anchor": "middle",
  });
  caption.textContent = "NUMBERS";
  svg.appendChild(caption);

  return svg;
}
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check assets/breakdown.js`
Expected: no output (success).

- [ ] **Step 3: Verify tests still pass**

Run: `npm test`
Expected: PASS — 32 tests, 0 failures. (Requiring the file must not touch `document`; if it throws `document is not defined`, a DOM call leaked to the top level.)

- [ ] **Step 4: Commit**

```bash
git add assets/breakdown.js
git commit -m "Render breakdown donuts as inline SVG

Uses pathLength=100 so dasharray and dashoffset are exact percentage
units with no circumference arithmetic. Each segment gets a transparent
wide companion circle as its hit target, since a 5-unit stroke is too
thin to hover reliably."
```

---

## Task 9: Cards, legend, and the public entry points

**Files:**
- Modify: `assets/breakdown.js`

- [ ] **Step 1: Add the card, legend, and entry points**

In `assets/breakdown.js`, add after `renderDonut` (before the export block):

```js
function renderLegend(dimension) {
  const list = document.createElement("ul");
  list.className = "bd-legend";

  dimension.categories.forEach((cat, i) => {
    const row = document.createElement("li");
    row.className = "bd-legend__row";
    row.tabIndex = 0;
    row.dataset.index = String(i);

    const swatch = document.createElement("span");
    swatch.className = "bd-legend__swatch";
    swatch.style.background = cat.color;
    row.appendChild(swatch);

    const name = document.createElement("span");
    name.className = "bd-legend__name";
    if (cat.statusRole) {
      const dot = document.createElement("span");
      dot.className = "bd-legend__status";
      dot.style.background = STATUS_COLORS[cat.statusRole];
      name.appendChild(dot);
    }
    // textContent, not innerHTML — these labels come from API data.
    name.appendChild(document.createTextNode(cat.label));
    name.title = cat.label;
    row.appendChild(name);

    const value = document.createElement("span");
    value.className = "bd-legend__value";
    value.textContent = fmtPct(cat.pct);
    const count = document.createElement("i");
    count.className = "bd-legend__count";
    count.textContent = fmtCount(cat.count);
    value.appendChild(count);
    row.appendChild(value);

    list.appendChild(row);
  });

  return list;
}

/** One category means the number IS the chart — a ring would say nothing. */
function renderTile(dimension) {
  const cat = dimension.categories[0];
  const tile = document.createElement("div");
  tile.className = "bd-tile";

  const value = document.createElement("div");
  value.className = "bd-tile__value";
  value.textContent = fmtPct(cat.pct);
  tile.appendChild(value);

  const name = document.createElement("div");
  name.className = "bd-tile__name";
  name.textContent = `${cat.label} · ${fmtCount(cat.count)}`;
  tile.appendChild(name);

  return tile;
}

function renderCard(dimension) {
  const card = document.createElement("div");
  card.className = "bd-card";

  const label = document.createElement("p");
  label.className = "bd-card__label";
  label.textContent = dimension.label;
  card.appendChild(label);

  const coverage = document.createElement("p");
  coverage.className = "bd-card__coverage";
  coverage.textContent =
    dimension.noData > 0
      ? `${fmtCount(dimension.withData)} with data · ${fmtCount(dimension.noData)} no data`
      : `${fmtCount(dimension.withData)} with data`;
  card.appendChild(coverage);

  if (dimension.categories.length === 1) {
    card.appendChild(renderTile(dimension));
    return card;
  }

  card.appendChild(renderDonut(dimension));
  card.appendChild(renderLegend(dimension));
  return card;
}

/**
 * Aggregate `results` and draw the breakdown into `container` (the <details>).
 * Hides the container when there is nothing chartable.
 */
function renderBreakdown(results, container) {
  if (!container) return;
  const grid = container.querySelector("#breakdownGrid");
  const coverage = container.querySelector("#breakdownCoverage");
  if (!grid || !coverage) return;

  const summary = computeBreakdown(results);
  grid.textContent = "";

  if (summary.dimensions.length === 0) {
    container.hidden = true;
    coverage.textContent = "";
    return;
  }

  const parts = [`${fmtCount(summary.total)} results`, `${fmtCount(summary.okCount)} OK`];
  if (summary.errorCount > 0) {
    const plural = summary.errorCount === 1 ? "error" : "errors";
    parts.push(`${fmtCount(summary.errorCount)} lookup ${plural}`);
  }
  coverage.textContent = parts.join(" · ");

  for (const dimension of summary.dimensions) {
    grid.appendChild(renderCard(dimension));
  }

  attachInteractions(grid, summary.dimensions);
  container.hidden = false;
}

function clearBreakdown(container) {
  if (!container) return;
  const grid = container.querySelector("#breakdownGrid");
  const coverage = container.querySelector("#breakdownCoverage");
  if (grid) grid.textContent = "";
  if (coverage) coverage.textContent = "";
  container.hidden = true;
}
```

Add a temporary no-op for the interaction wiring, replaced in Task 10:

```js
function attachInteractions() {}
```

Update the export block:

```js
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    pick,
    riskBand,
    titleCase,
    DIMENSIONS,
    computeBreakdown,
    MAX_SLICES,
  };
}
```

- [ ] **Step 2: Verify the file parses and tests still pass**

Run: `node --check assets/breakdown.js && npm test`
Expected: no `node --check` output; PASS — 32 tests, 0 failures.

- [ ] **Step 3: Commit**

```bash
git add assets/breakdown.js
git commit -m "Build breakdown cards, legend, and public entry points

The legend is load-bearing rather than decorative: it lists every
category with its percentage and exact count, so a sub-1% slice stays
readable and no value is reachable only by hovering. Labels are set via
textContent since they come from API data. A single-category dimension
degrades to a stat tile instead of a fully-filled ring."
```

---

## Task 10: Hover and focus emphasis

Emphasis dims the *other* segments rather than recolouring the active one, so a category's hue never changes meaning mid-interaction.

**Files:**
- Modify: `assets/breakdown.js`

- [ ] **Step 1: Replace the no-op with the real wiring**

In `assets/breakdown.js`, replace `function attachInteractions() {}` with:

```js
function ensureTooltip(grid) {
  const host = grid.closest(".breakdown") || grid.parentElement;
  let tip = host.querySelector(".bd-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "bd-tooltip";
    tip.hidden = true;
    host.appendChild(tip);
  }
  return tip;
}

function fillTooltip(tip, cat) {
  tip.textContent = "";
  const head = document.createElement("div");
  head.textContent = `${cat.label} — ${fmtPct(cat.pct)} (${fmtCount(cat.count)})`;
  tip.appendChild(head);

  // "Other" would otherwise hide what it folded.
  if (Array.isArray(cat.folded) && cat.folded.length > 0) {
    const list = document.createElement("ul");
    list.className = "bd-tooltip__folded";
    for (const f of cat.folded) {
      const item = document.createElement("li");
      item.textContent = `${f.label} · ${fmtCount(f.count)}`;
      list.appendChild(item);
    }
    tip.appendChild(list);
  }
}

function positionTooltip(tip, grid, target) {
  const host = grid.closest(".breakdown") || grid.parentElement;
  const hostBox = host.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  const left = box.left - hostBox.left + box.width / 2;
  const top = box.top - hostBox.top;
  tip.style.left = `${Math.max(4, Math.min(left, hostBox.width - 4))}px`;
  tip.style.top = `${Math.max(4, top)}px`;
  tip.style.transform = "translate(-50%, calc(-100% - 6px))";
}

/**
 * Hover or focus a segment or a legend row and both highlight together.
 * Keyboard focus shows exactly what hover shows; the tooltip only ever
 * repeats values the legend already prints, so nothing is gated behind it.
 */
function attachInteractions(grid, dimensions) {
  const tip = ensureTooltip(grid);
  const cards = [...grid.querySelectorAll(".bd-card")];

  cards.forEach((card, cardIndex) => {
    const dimension = dimensions[cardIndex];
    if (!dimension) return;

    const show = (index, target) => {
      const cat = dimension.categories[index];
      if (!cat) return;
      card.classList.add("bd-card--focus");
      card.querySelectorAll(".bd-donut__seg").forEach((seg) => {
        seg.classList.toggle("bd-donut__seg--on", seg.dataset.index === String(index));
      });
      fillTooltip(tip, cat);
      tip.hidden = false;
      positionTooltip(tip, grid, target);
    };

    const hide = () => {
      card.classList.remove("bd-card--focus");
      card.querySelectorAll(".bd-donut__seg--on").forEach((seg) => {
        seg.classList.remove("bd-donut__seg--on");
      });
      tip.hidden = true;
    };

    const targets = [
      ...card.querySelectorAll("circle[data-index]"),
      ...card.querySelectorAll(".bd-legend__row"),
    ];
    for (const target of targets) {
      const index = Number(target.dataset.index);
      target.addEventListener("mouseenter", () => show(index, target));
      target.addEventListener("focus", () => show(index, target));
      target.addEventListener("mouseleave", hide);
      target.addEventListener("blur", hide);
    }
    card.addEventListener("mouseleave", hide);
  });
}
```

- [ ] **Step 2: Verify the file parses and tests still pass**

Run: `node --check assets/breakdown.js && npm test`
Expected: no `node --check` output; PASS — 32 tests, 0 failures.

- [ ] **Step 3: Commit**

```bash
git add assets/breakdown.js
git commit -m "Add hover and keyboard emphasis with a shared tooltip

Emphasis dims the other segments rather than recolouring the active one,
so a hue never changes meaning mid-interaction. Legend rows are
focusable and show exactly what hover shows. The Other tooltip lists
what it folded, which is otherwise invisible."
```

---

## Task 11: Wire into app.js

**Files:**
- Modify: `assets/app.js:776-779` and `assets/app.js:797-803`

- [ ] **Step 1: Render on success**

In `runLookup`, find:

```js
    lastResponse = results;
    renderTable(results);
    el("exportCsv").disabled = !results.length;
```

Replace with:

```js
    lastResponse = results;
    renderTable(results);
    renderBreakdown(results, el("breakdownBlock"));
    el("exportCsv").disabled = !results.length;
```

- [ ] **Step 2: Clear on hard error**

In the same function's `catch` block, find:

```js
    if (!aborted) {
      lastResponse = null;
      el("resultsBody").innerHTML = "";
      el("rawJson").textContent = "";
      el("resultCount").textContent = "0 rows";
      el("previewNote").hidden = true;
    }
```

Replace with:

```js
    if (!aborted) {
      lastResponse = null;
      el("resultsBody").innerHTML = "";
      el("rawJson").textContent = "";
      el("resultCount").textContent = "0 rows";
      el("previewNote").hidden = true;
      clearBreakdown(el("breakdownBlock"));
    }
```

- [ ] **Step 3: Verify both files parse**

Run: `node --check assets/app.js && node --check assets/breakdown.js`
Expected: no output.

- [ ] **Step 4: Verify in the running app**

Run: `npm run dev`

Sign in, then paste these numbers into the textarea, tick **line_type_intelligence** and **sms_pumping_risk**, and run:

```
+14155552671
+447700900123
+61412345678
not-a-phone-number
```

Expected:
- A **Breakdown** block appears above the table, open.
- Coverage line reads `4 results · 3 OK · 1 lookup error` (exact counts depend on which numbers validate).
- A **Line type** donut and an **SMS pumping risk** donut appear; **Line status** does not, because that field was not requested.
- Each legend row shows a percentage and an exact count.
- Hovering a segment highlights it, dims its siblings, and shows a tooltip; tabbing to a legend row does the same.
- Untick both packages, run again: the donuts are replaced by a single **Country** card (validation and `countryCode` come back free on every request).

- [ ] **Step 5: Commit**

```bash
git add assets/app.js
git commit -m "Render the breakdown when a run completes

Hooks into the two places runLookup already handles results: render
alongside renderTable on success, clear alongside the other result
elements on a hard error. A cancelled run charts what it kept, and the
coverage line names the real count so a partial set cannot read as
complete."
```

---

## Task 12: CI coverage

`ci.yml:31` hardcodes `assets/app.js`, so `breakdown.js` would never be syntax-checked. Widening the glob also covers any future asset script.

**Files:**
- Modify: `.github/workflows/ci.yml:29-36`

- [ ] **Step 1: Widen the syntax check and add the test run**

In `.github/workflows/ci.yml`, replace:

```yaml
      - name: Syntax-check Functions and frontend
        run: |
          for f in functions/*.js assets/app.js; do
            node --check "$f" && echo "ok  $f"
          done
```

with:

```yaml
      - name: Syntax-check Functions and frontend
        run: |
          for f in functions/*.js assets/*.js; do
            node --check "$f" && echo "ok  $f"
          done

      - name: Unit tests
        run: npm test
```

- [ ] **Step 2: Verify locally what CI will run**

Run:

```bash
for f in functions/*.js assets/*.js; do node --check "$f" && echo "ok  $f"; done && npm test
```

Expected: `ok` for `functions/lookup.js`, `functions/verify.js`, `assets/app.js`, `assets/breakdown.js`, then PASS — 32 tests, 0 failures.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "Check every asset script in CI and run the unit tests

The syntax-check loop hardcoded assets/app.js, so breakdown.js would
have gone unchecked. node:test needs no new dependencies on either
Node 22 or 24."
```

---

## Verification checklist

Before calling this done, confirm each with actual output, not assumption:

- [ ] `npm test` — 32 tests pass
- [ ] `for f in functions/*.js assets/*.js; do node --check "$f"; done` — clean
- [ ] A run with only `line_type_intelligence` ticked shows exactly two cards (Line type, Country) — proving the chart set follows the returned fields
- [ ] A run with a deliberately invalid number shows a non-zero error count in the coverage line, and that number is in no denominator
- [ ] A run where one number returns `line_status` and another doesn't shows differing `with data` counts per card
- [ ] Tabbing reaches every legend row and highlights the matching segment
- [ ] Cancelling mid-run still renders a breakdown, with the coverage line naming the partial count

## Out of scope

Live chart updates during a run, cross-run comparison, chart image export, click-a-segment-to-filter-the-table, dark mode.
