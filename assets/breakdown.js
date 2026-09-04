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

/* Requireable from node:test while staying a plain browser script. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { pick, riskBand };
}
