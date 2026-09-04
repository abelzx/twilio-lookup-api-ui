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
