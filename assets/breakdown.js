/**
 * Results breakdown — one donut per Lookup data package the run returned.
 *
 * Aggregation (`computeBreakdown`) is a pure function of the results array and is
 * unit-tested; rendering touches only the container element it is handed.
 * See docs/superpowers/specs/2026-09-03-results-breakdown-charts-design.md
 */

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

/*
 * Temporary stubs. Task 5 replaces ordinalCategories with real severity
 * ordering and colour-ramp assignment; Task 6 replaces nominalCategories with
 * count ordering, hue assignment, and fold-to-Other. Do not implement that
 * logic here.
 */
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

/* Requireable from node:test while staying a plain browser script. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { pick, riskBand, titleCase, DIMENSIONS, computeBreakdown };
}
