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

/* Requireable from node:test while staying a plain browser script. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { pick, riskBand, titleCase, DIMENSIONS };
}
