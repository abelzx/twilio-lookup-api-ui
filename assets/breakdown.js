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

/**
 * Max donut slices before folding into "Other" — derived from the palette so the
 * two can't drift. If this were bumped past the number of validated hues, a real
 * named category would fall back to NEUTRAL and be indistinguishable from "Other".
 */
const MAX_SLICES = CATEGORICAL.length;

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
    // One slot goes to "Other", so only MAX_SLICES - 1 real categories survive.
    const keepCount = MAX_SLICES - 1;
    const ranked = [...all].sort(byCount);
    visible = ranked.slice(0, keepCount);
    folded = ranked.slice(keepCount);
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
      } catch (err) {
        // A malformed row must not take down the panel, but stay noisy about it:
        // an extractor throwing for EVERY row looks identical to a field the
        // network simply doesn't return, and that silence would hide a real bug.
        console.warn(`breakdown: ${dim.id} extractor threw, counting as no data`, err);
        value = null;
      }
      // "" is filtered here rather than inside `pick` or each extractor: `pick`
      // answers "is this key populated", while "empty means no data" is an
      // aggregation rule that belongs in exactly one place.
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
  // Cards can legitimately disagree on their totals, because each percentage is
  // over the numbers that returned that field. Say so once here rather than
  // caveating every card — and note "no data" absorbs the failed lookups above,
  // so the two figures aren't additive.
  coverage.textContent =
    `${parts.join(" · ")}. Percentages are of the numbers that returned each ` +
    `field, so totals differ per card; "no data" includes lookups that failed.`;

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

/* Replaced in Task 10 with the real hover/focus wiring. */
function attachInteractions() {}

/* Requireable from node:test while staying a plain browser script. */
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
