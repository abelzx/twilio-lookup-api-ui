# Results breakdown charts — design

**Date:** 2026-09-03
**Status:** approved, ready for implementation planning

## Problem

A bulk run returns thousands of rows. The Results panel shows a 400-row table
preview and a Raw JSON block, so the only way to answer "what proportion of this
list is unreachable?" is to export the CSV and pivot it elsewhere. The run's
composition should be readable in the app.

## Solution summary

A collapsible **Breakdown** block at the top of the Results panel, holding one
donut chart per data package the run actually returned. Charts render once, when
the run finishes or is cancelled. No new runtime dependencies: hand-rolled SVG.

## Decisions

Recorded because each was a real fork, not an obvious default:

| Decision | Choice | Why |
|---|---|---|
| Chart form | Donut per field | User preference over bar breakdowns. Mitigated by making the legend carry all values (see §4). |
| Placement | Inside Results panel, above the table | User preference over a full-width panel. Constrains card width to a half-column, so legends sit *below* donuts rather than beside them. |
| Update timing | End of run only | Charts computed from the full result set are always accurate; a mid-run donut invites wrong conclusions. Progress bar and req/s already cover in-flight feedback. |
| Rendering | Hand-rolled SVG | The frontend ships zero runtime dependencies today. A CDN chart library adds an external request per page load; vendoring one costs far more weight than four donuts justify. |
| Denominators | Per-dimension | See §2. |
| Validity | Text line, not a donut | Out of the requested scope, but the denominators are meaningless without it. |

## 1. Dimension registry

`assets/breakdown.js` holds a registry. A card renders **only if at least one
result has a non-null value** for that dimension — this is the dynamic
field-selection behaviour: a `line_type_intelligence`-only run shows one donut, a
full run shows four.

| id | Label | Source path | Scale | Categories |
|---|---|---|---|---|
| `lineStatus` | Line status | `lineStatus.status` | ordinal | Reachable, Active, Unreachable, Inactive, Unknown |
| `lineType` | Line type | `lineTypeIntelligence.type` | nominal | up to 11 Twilio values, folded (§3) |
| `riskBand` | SMS pumping risk | `smsPumpingRisk.sms_pumping_risk_score` | ordinal | Low, Mild, Moderate, High |
| `country` | Country | `countryCode` | nominal | folded (§3) |

### Key casing

`functions/lookup.js` returns `resource.toJSON()`, which gives camelCase
top-level keys while nested package objects keep the API's snake_case
(`sms_pumping_risk_score`, `error_code`). `assets/app.js` already hedges this way
in `summarizeSuccess` (`data.national_format || data.nationalFormat`). Every
extractor reads both spellings via a shared `pick(obj, "snake_name", "camelName")`
helper rather than assuming one.

### Risk bands

From Twilio's published guidance
(<https://www.twilio.com/docs/lookup/v2-api/sms-pumping-risk>). Boundaries are
half-open so every score lands in exactly one band:

| Band | Score |
|---|---|
| Low | `0 <= s < 60` |
| Mild | `60 <= s < 75` |
| Moderate | `75 <= s < 90` |
| High | `90 <= s <= 100` |

A null or non-numeric score is "no data", not a band.

### Line status ordering

Fixed, best-to-worst: Reachable, Active, Unreachable, Inactive, Unknown. Not
sorted by count — the order carries meaning. `Unknown` is treated as neutral (no
position on the severity scale), so it takes the muted grey, not a ramp step.

## 2. Denominators

**Each dimension's percentages are over the numbers that returned that field,
not over the run total.**

If 120 of 2,500 numbers return `lineStatus: null` because the network isn't
supported, "9% Inactive" computed over 2,500 understates the real inactive rate
among numbers Twilio could actually assess. So each card states its own coverage:

```
Line status
2,380 with data · 120 no data
```

Consequence, accepted: two cards in the same run can show different totals. The
per-card coverage line is what makes that legible rather than confusing.

Counted as "no data" for a dimension:

- the result failed entirely (`ok: false`)
- the package object is absent or `null`
- the package returned an `error_code` (e.g. 60600 unsupported) instead of a value
- the value is present but empty or non-parseable

A number can have a line type and no risk score; exclusion is per-dimension, never
per-row.

### Panel header

One line above the cards, since the per-card denominators can't be interpreted
without it:

```
2,500 results · 2,486 OK · 14 lookup errors
```

On a cancelled run this reflects what was kept, so a partial set cannot be
misread as a complete one.

## 3. Category folding

Nominal dimensions cap at **6 slices**:

- 6 or fewer distinct categories → all shown, each with its own hue
- more than 6 → **top 5 by count** plus `Other (n)`, where `n` is the number of
  folded categories

Ties on count are broken by the dimension's stable key order (§5), so folding is
deterministic rather than dependent on object iteration order.

`Other` always renders in muted grey and always sorts last. Its tooltip lists the
folded categories with their counts, and every folded value remains in the CSV
export — nothing is only reachable through the chart.

Ordinal dimensions are never folded; their category sets are fixed and small.

## 4. Card anatomy

Container: `<details class="details" open>` at the top of the Results panel,
before `.table-wrap`, matching the existing Raw JSON pattern.

Card grid: `repeat(auto-fit, minmax(210px, 1fr))` — two donuts per row in the
half-width column, one per row when `.layout` collapses to single-column at
960px. No fixed heights; cards grow with their legend.

Each card, top to bottom:

1. Field label (existing uppercase panel-heading treatment)
2. Coverage line (§2), muted
3. 96px donut, total-with-data in the centre in the app sans at proportional
   figures, `NUMBERS` beneath it in muted small caps
4. Legend: one row per category — colour swatch, category name, `%`, count

**The legend is load-bearing.** It is how a 1.6% sliver stays readable, and it is
the chart's text equivalent, so no value is reachable only by hovering. Legend
values use `tabular-nums` (they align vertically); the centre total does not
(proportional figures at display size).

Number formatting: percentages to one decimal place (`7.5%`), counts
thousands-separated via `toLocaleString()`. Rounded percentages may sum to
99.9% or 100.1%; they are not fudged to force 100, and the counts beside them
are exact.

Rows for semantically notable states carry a status dot **and** their name —
`Inactive` critical, `Unreachable` warning. Colour never carries meaning alone.

### Degenerate cases

| Case | Render |
|---|---|
| exactly 1 category | Stat tile (`mobile — 100% · 2,500`), not a 100%-filled ring |
| 0 numbers with data | No card at all |
| no dimension has data | No Breakdown block at all |

## 5. Colour

All values below were run through the dataviz validator against this app's white
surface (`#FFFFFF`), not chosen by eye.

**Ordinal ramp** (line status, risk) — single blue hue, light→dark:

| k | steps |
|---|---|
| 2 | `#86b6ef` `#104281` |
| 3 | `#86b6ef` `#2a78d6` `#104281` |
| 4 | `#86b6ef` `#2a78d6` `#1c5cab` `#104281` |
| 5 | `#86b6ef` `#5598e7` `#2a78d6` `#1c5cab` `#104281` |

Result: monotone lightness, all adjacent ΔL ≥ 0.06, light end 2.11:1 vs surface,
hue spread 3° — **PASS**.

`k` counts only the non-neutral categories, so line status uses 4 steps (Unknown
is neutral) and risk uses 4. If Twilio ever returns an ordinal value outside the
known set, it is treated as neutral — muted grey, sorted last — rather than
extending the ramp past 5 steps.

**Categorical slots** (line type, country), assigned in fixed order:

`#2a78d6` `#eb6834` `#1baf7a` `#eda100` `#e87ba4` `#008300`

Worst adjacent CVD ΔE 9.1, worst adjacent normal-vision ΔE 19.6 — **PASS**. The
donut's wrap-around pair (slot 1 meets the last slot at 12 o'clock) was validated
separately: `#2a78d6`↔`#008300` ΔE 26.5 — **PASS**.

**Neutral** `#8891AA` (the app's `--text-muted`) for `Unknown` and `Other`. These
are "no position on the scale", not series, so the chroma floor doesn't apply.

**Colour follows the entity, not the rank.** Slices are *ordered* by count, but
hues are *not* assigned by count. Each dimension has a stable key order — a
canonical list for line type (`mobile`, `landline`, `fixedVoip`, `nonFixedVoip`,
`tollFree`, `premium`, `sharedCost`, `uan`, `voicemail`, `pager`, `unknown`),
alphabetical for country — and slots go to the visible categories in that order.

Precisely: take the categories that survive folding, sort them by stable key
order, and assign slots 1..n in that sequence. So a category's hue never changes
because its count moved, and `mobile` takes slot 1 whenever it is present (it is
first in the canonical list).

The limit, stated because it is real: there are 6 slots and up to 11 line types,
so the mapping is stable *for a given set of visible categories*. Two runs whose
visible sets differ can assign the same category to different slots. Full
cross-run hue stability would need a fixed hue per known category, which would
force two line types to share a hue — a worse trade than this one.

**Status colours are not used as a scheme.** A five-way good/warning/critical
palette fails colourblind separation outright: `#d03b3b`↔`#0ca30c` measures
ΔE 4.1 under deuteranopia. Status appears only as a dot beside a text label
(§4), where the label carries the meaning.

Segments are separated by a 2px white gap, not a stroke. Legend and axis text
wear the app's ink tokens (`--text`, `--text-secondary`, `--text-muted`); text
never wears the series colour.

The app has no dark mode (no `prefers-color-scheme` rules in `styles.css`), so
only the light set is specified. If dark mode is added later, the ramps must be
re-stepped and re-validated against the dark surface — not flipped.

## 6. Geometry

SVG `stroke-dasharray` on concentric circles: `viewBox="0 0 42 42"`, `r=15.9`,
`stroke-width=5`, circumference ≈ 99.9 units.

- Segment dash = `pct − gap`, where `gap ≈ 0.9` units (≈2px at the 96px render
  size), floored so a segment never goes below `0.5` units and vanishes entirely
- `stroke-dashoffset` = `25 − cumulativePct`, which starts the first segment at
  12 o'clock
- Slices under ~1% are near-invisible by geometry. This is expected and is
  precisely why the legend carries every value.

## 7. Interaction

- Hover or focus a segment → tooltip: category, count, %
- Hover or focus a legend row → the matching segment is emphasised (others drop
  in opacity); keyboard focus shows exactly what hover shows
- Segments are thin, so each carries a transparent wider-stroke companion circle
  as its hit target (~24px effective)
- Legend rows are focusable and are the primary accessible interactive surface
- `Other` tooltip lists the folded categories and counts
- No entrance animation, so there is nothing to suppress under
  `prefers-reduced-motion`

The `<svg>` carries `role="img"` and an `aria-label` summarising the top
categories; the legend below it is the full text equivalent.

## 8. Module boundary

New file `assets/breakdown.js`, loaded before `app.js` in `index.html`. Public
surface, two functions:

```js
renderBreakdown(results, containerEl)  // aggregate + draw
clearBreakdown(containerEl)            // reset to empty
```

Aggregation is a pure function of `results`. `breakdown.js` does not read
`lastResponse`, does not fetch, and does not touch any DOM outside
`containerEl`.

`app.js` calls it in the two places it already handles results:

- after `renderTable(results)` on success (`app.js:777`)
- in the `catch` block that clears `resultsBody` / `rawJson` / `resultCount` /
  `previewNote` (`app.js:799`)

Cost: one O(n) pass **per dimension** over an array already in memory, plus one
for the run-level counts — five traversals as implemented, not one. At 50,000
rows that is ~250k simple iterations, low single-digit milliseconds, and it runs
once at end-of-run rather than per frame. Interleaving four independent maps and
four try/catch scopes into a single loop would trade real clarity for a win that
is imperceptible at this scale, so the per-dimension loop stands.

Unknown or unexpected values become their own category rather than throwing, so a
new Twilio enum value appears as itself instead of breaking the panel.

## 9. Testing

`node:test` is built into Node 22 and 24 (both CI targets), so this adds no
dependencies. `package.json` gains `"test": "node --test"`.

`breakdown.js` ends with a `module.exports` sniff
(`if (typeof module !== "undefined" && module.exports) { ... }`) so the pure
aggregator is requireable from tests while the file stays a plain browser script.

`test/breakdown.test.js` covers the aggregator:

- risk band boundaries at 0, 59, 60, 74, 75, 89, 90, 100, and null
- per-dimension denominators with mixed nulls, `ok: false` rows, and per-package
  `error_code`
- both key spellings (`sms_pumping_risk_score` and `smsPumpingRiskScore`)
- fold-to-`Other` at exactly 6 and at 7+ distinct categories
- stable hue assignment: the same category gets the same slot across two runs
  with different count orderings
- empty input, all-errors input, single-category input
- line status fixed ordering, and `Unknown` treated as neutral

Rendering is verified by running the app against a CSV and looking at it, not by
unit test.

## 10. Files touched

| File | Change |
|---|---|
| `assets/breakdown.js` | new — registry, aggregator, SVG renderer |
| `assets/index.html` | Breakdown `<details>` in the Results panel; `<script>` tag |
| `assets/styles.css` | `.breakdown` block, card grid, legend, tooltip |
| `assets/app.js` | two call sites (render on success, clear on error) |
| `test/breakdown.test.js` | new — aggregator tests |
| `package.json` | `test` script |
| `.github/workflows/ci.yml` | add `assets/breakdown.js` to the `node --check` loop (line 31 hardcodes `assets/app.js`); add an `npm test` step |
| `.gitignore` | ignore `.superpowers/` (brainstorm mockup output) |

`test/` sits outside `functions/` and `assets/`, so it is not uploaded by
`twilio serverless:deploy`.

## Out of scope

- Live/streaming chart updates during a run
- Cross-run comparison or history
- Chart image export (CSV export already covers the underlying data)
- Filtering the table by clicking a segment
- Dark mode
