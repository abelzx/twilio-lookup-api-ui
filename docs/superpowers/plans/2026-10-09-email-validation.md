# Email Validation Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an **Email** tab that bulk-validates addresses through SendGrid's Email Address Validation API, alongside the existing Lookup tab.

**Architecture:** A new `POST /email` Function calls SendGrid once per address with the caller's own API key. The browser batching code moves out of `app.js` into a shared `assets/batch.js` (`runInBatches` plus CSV helpers) so both tabs use one code path. `assets/email.js` holds the Email tab's state and rendering; `app.js` gains a tab bar.

**Tech Stack:** Twilio Serverless Functions (Node 24 runtime, built-in `fetch`), vanilla browser JS loaded as plain `<script>` tags, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-08-email-validation-design.md`

## Global Constraints

- No new npm dependencies. The Function uses built-in `fetch`, as `functions/verify.js` does.
- No bundler, no ES modules. Browser files are plain scripts; Node tests `require` them through the guard `if (typeof module !== "undefined" && module.exports)`.
- Script order in `index.html`: `batch.js`, `breakdown.js`, `app.js`, `email.js`.
- Classic scripts share one global scope. Every top-level name in `assets/email.js` starts with `email` (or contains `Email`/`Sendgrid`) so it can never overwrite an `app.js` function such as `setStatus` or `renderTable`.
- All element IDs in the Email panel start with `email` (e.g. `emailList`, `emailRun`).
- SendGrid key lives in `sessionStorage` under `twilio_lookup_sendgrid`. Sign out removes it.
- `/email` concurrency: clamped to 1–7, default 5. Per-request timeout 4 s. 429 retried at most twice, after 250 ms then 750 ms.
- Exact copy:
  - Empty list: `Provide at least one email address.`
  - Missing key (server): `A SendGrid API key is required.`
  - Key rejected: `SendGrid rejected the API key. It needs the Email Address Validation scope, which is available on Email API Pro and Premier plans only.`
  - Timeout row: `SendGrid did not respond in time.`
  - Missing key (UI): `Enter a SendGrid API key first.`
  - Key hint: `Needs an API key with the Email Address Validation scope (Email API Pro or Premier).`
  - Billing: `Each address is one billable validation.`
- Export filename: `sendgrid-email-validation-<timestamp>.csv`.
- Lookup tab behaviour does not change: same defaults, same status text, same progress bar.

**One addition to the spec.** The spec gives each SendGrid request a 4 s timeout and says this keeps a slow upstream from becoming a platform timeout. With 30 addresses at concurrency 7 that is 5 rounds, so the worst case is 20 s, past the 10 s Function limit. `/email` therefore also tracks an 8.5 s invocation budget: a request that would start after it, or a 429 retry that would wait past it, is reported as `SendGrid did not respond in time.` instead. The Email tab's batch size is capped at 50 for the same reason.

---

## File Structure

| File | Responsibility |
|---|---|
| `assets/batch.js` | **New.** `runInBatches`, CSV parse/export helpers, `uniqueLines`. Shared by both tabs. |
| `test/batch.test.js` | **New.** `runInBatches` with stubbed `fetch`; moved helpers. |
| `functions/email.js` | **New.** `POST /email`. |
| `test/email-function.test.js` | **New.** Handler with stub `Twilio.Response` and stubbed `fetch`. |
| `assets/email.js` | **New.** Email tab state, run, rendering, export. |
| `test/email-summary.test.js` | **New.** The two pure helpers in `assets/email.js`. |
| `assets/app.js` | Remove the moved code; call `runInBatches`; tab bar; sign out clears the SendGrid key. |
| `assets/index.html` | Tab bar, header variants, Email panel, script tags. |
| `assets/styles.css` | Tab bar, verdict colours, key row, billing note. |
| `README.md`, `docs/design.md` | Feature docs. |

---

## Task 1: Shared batch module

**Files:**
- Create: `assets/batch.js`
- Test: `test/batch.test.js`

**Interfaces:**
- Produces (all global functions in the browser, also in `module.exports`):
  - `runInBatches({ items: string[], endpoint: string, buildBody: (slice: string[]) => object, batchSize: number, parallelBatches: number, signal: AbortSignal, onProgress?: (done: number, total: number) => void }) → Promise<{ results: any[], cancelled: boolean }>`
  - `parseCsv(text: string) → string[][]`, `stripBom(s: string) → string`
  - `extractColumnFromCsvRows(rows: string[][], columnOneBased: number) → string[]`
  - `uniqueLines(text: string) → string[]`
  - `flattenRecord(obj, prefix?) → Record<string,string>`, `formatCell(v) → string`, `resultsToRows(results) → Record<string,string>[]`, `toCsv(rows) → string`, `downloadCsv(text, filename) → void`
  - `anyAbortSignal(signals: AbortSignal[]) → AbortSignal`, `mergeChunkResultsPrefix(chunkResults: any[][], nChunks: number) → any[]`, `yieldToUi() → Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `test/batch.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseCsv,
  stripBom,
  extractColumnFromCsvRows,
  uniqueLines,
  flattenRecord,
  resultsToRows,
  toCsv,
  mergeChunkResultsPrefix,
  runInBatches,
} = require("../assets/batch.js");

// ---------------------------------------------------------------------------
// runInBatches
// ---------------------------------------------------------------------------

/** Replaces global fetch for one test. `respond(items, init)` returns [status, body]. */
function stubFetch(t, respond) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const { items } = JSON.parse(init.body);
    calls.push({ url, items });
    const [status, body] = await respond(items, init);
    return new Response(JSON.stringify(body), { status });
  };
  t.after(() => {
    global.fetch = original;
  });
  return calls;
}

const echo = (items) => [200, { results: items.map((input) => ({ input, ok: true })) }];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Rejects the way fetch does when its signal is aborted. */
function waitForAbort(signal) {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError"))
    );
  });
}

function baseOptions(overrides) {
  return {
    items: [],
    endpoint: "/test",
    buildBody: (slice) => ({ items: slice }),
    batchSize: 2,
    parallelBatches: 2,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("runInBatches keeps input order when batches finish out of order", async (t) => {
  const calls = stubFetch(t, async (items) => {
    if (items.includes("a")) await delay(30);
    return echo(items);
  });
  const progress = [];
  const out = await runInBatches(
    baseOptions({
      items: ["a", "b", "c", "d", "e"],
      onProgress: (done, total) => progress.push([done, total]),
    })
  );
  assert.deepEqual(
    out.results.map((r) => r.input),
    ["a", "b", "c", "d", "e"]
  );
  assert.equal(out.cancelled, false);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "/test");
  // The slow first batch reports last.
  assert.deepEqual(progress, [
    [2, 5],
    [3, 5],
    [5, 5],
  ]);
});

test("runInBatches with nothing to do makes no request", async (t) => {
  const calls = stubFetch(t, echo);
  const out = await runInBatches(baseOptions({ items: [] }));
  assert.deepEqual(out, { results: [], cancelled: false });
  assert.equal(calls.length, 0);
});

test("runInBatches returns the completed prefix on cancel", async (t) => {
  const calls = stubFetch(t, echo);
  const ctrl = new AbortController();
  const out = await runInBatches(
    baseOptions({
      items: ["a", "b", "c", "d"],
      parallelBatches: 1,
      signal: ctrl.signal,
      onProgress: () => ctrl.abort(),
    })
  );
  assert.deepEqual(
    out.results.map((r) => r.input),
    ["a", "b"]
  );
  assert.equal(out.cancelled, true);
  assert.equal(calls.length, 1);
});

test("runInBatches rejects with the server error and stops other batches", async (t) => {
  const calls = stubFetch(t, async (items, init) => {
    if (items.includes("a")) return [401, { error: "SendGrid rejected the API key." }];
    return waitForAbort(init.signal);
  });
  await assert.rejects(
    runInBatches(baseOptions({ items: ["a", "b", "c"], batchSize: 1 })),
    { message: "SendGrid rejected the API key." }
  );
  assert.deepEqual(
    calls.map((c) => c.items),
    [["a"], ["b"]]
  );
});

test("runInBatches rejects on a network error", async (t) => {
  const original = global.fetch;
  global.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  t.after(() => {
    global.fetch = original;
  });
  await assert.rejects(runInBatches(baseOptions({ items: ["a"] })), {
    message: "fetch failed",
  });
});

test("mergeChunkResultsPrefix stops at the first missing chunk", () => {
  assert.deepEqual(mergeChunkResultsPrefix([[1, 2], [3]], 2), [1, 2, 3]);
  assert.deepEqual(mergeChunkResultsPrefix([[1], undefined, [3]], 3), [1]);
});

// ---------------------------------------------------------------------------
// CSV input
// ---------------------------------------------------------------------------

test("parseCsv handles quoted commas, quoted newlines and CRLF", () => {
  assert.deepEqual(parseCsv('a,"b,c"\r\n"x\ny",z\n'), [
    ["a", "b,c"],
    ["x\ny", "z"],
  ]);
});

test("parseCsv unescapes doubled quotes and skips blank lines", () => {
  assert.deepEqual(parseCsv('q,"he said ""hi"""\n\nlast'), [
    ["q", 'he said "hi"'],
    ["last"],
  ]);
});

test("stripBom removes a leading byte-order mark only", () => {
  assert.equal(stripBom("\uFEFFa,b"), "a,b");
  assert.equal(stripBom("a,b"), "a,b");
});

test("extractColumnFromCsvRows trims, skips short rows and de-duplicates", () => {
  const rows = [["x", "1"], ["y"], ["z", "1"], ["w", " 2 "], ["v", ""]];
  assert.deepEqual(extractColumnFromCsvRows(rows, 2), ["1", "2"]);
  assert.deepEqual(extractColumnFromCsvRows(rows, 0), ["x", "y", "z", "w", "v"]);
});

test("uniqueLines splits on newlines and commas", () => {
  assert.deepEqual(uniqueLines(" a \nb,a\r\n\n c"), ["a", "b", "c"]);
  assert.deepEqual(uniqueLines(""), []);
});

// ---------------------------------------------------------------------------
// CSV output
// ---------------------------------------------------------------------------

test("flattenRecord dots nested keys, joins arrays and blanks nulls", () => {
  assert.deepEqual(
    flattenRecord({ a: { b: 1, c: { d: null } }, list: [1, "x", { k: 1 }], n: null }),
    { "a.b": "1", "a.c.d": "", list: '1; x; {"k":1}', n: "" }
  );
});

test("resultsToRows puts status columns first and flattens data", () => {
  assert.deepEqual(
    resultsToRows([
      { input: "a", ok: true, data: { v: { w: 2 } } },
      { input: "b", ok: false, error: "nope", code: 400 },
    ]),
    [
      { input: "a", ok: "true", error: "", error_code: "", "v.w": "2" },
      { input: "b", ok: "false", error: "nope", error_code: "400" },
    ]
  );
});

test("toCsv escapes and takes the union of keys", () => {
  assert.equal(
    toCsv([{ a: "1", b: 'x,"y"' }, { c: "line\nbreak" }]),
    'a,b,c\r\n1,"x,""y""",\r\n,,"line\nbreak"'
  );
  assert.equal(toCsv([]), "");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/batch.test.js`
Expected: FAIL with `Cannot find module '../assets/batch.js'`

- [ ] **Step 3: Write `assets/batch.js`**

`parseCsv`, `stripBom`, `anyAbortSignal`, `mergeChunkResultsPrefix`, `flattenRecord`, `formatCell`, `resultsToRows`, `toCsv`, `downloadCsv` and `yieldToUi` are copied from `assets/app.js` unchanged. `runInBatches` is `runLookupInChunks` with the Lookup-specific parts lifted into parameters.

```js
/**
 * Batch runner and CSV helpers shared by the Lookup and Email tabs.
 *
 * A plain browser script, loaded before app.js and email.js. Only downloadCsv
 * touches the DOM, so node:test can require the rest through the export guard
 * at the bottom.
 * See docs/superpowers/specs/2026-10-08-email-validation-design.md
 */

function yieldToUi() {
  return new Promise((r) => setTimeout(r, 0));
}

/** RFC-style CSV parse (quotes, commas, newlines inside quoted fields). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n") {
      row.push(cur);
      if (row.some((cell) => String(cell).length > 0)) rows.push(row);
      row = [];
      cur = "";
    } else if (c === "\r") {
      if (next === "\n") i++;
      row.push(cur);
      if (row.some((cell) => String(cell).length > 0)) rows.push(row);
      row = [];
      cur = "";
    } else {
      cur += c;
    }
  }
  row.push(cur);
  if (row.some((cell) => String(cell).length > 0)) rows.push(row);
  return rows;
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * @param {string[][]} rows
 * @param {number} columnOneBased 1 = first column
 */
function extractColumnFromCsvRows(rows, columnOneBased) {
  const col = Math.max(1, Math.floor(columnOneBased)) - 1;
  const raw = [];
  for (const r of rows) {
    if (!r || col >= r.length) continue;
    const v = String(r[col] ?? "").trim();
    if (v) raw.push(v);
  }
  return [...new Set(raw)];
}

/** Textarea input: one value per line or comma-separated. Duplicates are removed. */
function uniqueLines(text) {
  return [
    ...new Set(
      String(text)
        .split(/[\r\n,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    ),
  ];
}

/** @param {AbortSignal[]} signals */
function anyAbortSignal(signals) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any(signals);
  }
  return signals[0];
}

/** Merge chunk results in file order; stop at first missing chunk (cancel / in-flight). */
function mergeChunkResultsPrefix(chunkResults, nChunks) {
  const all = [];
  for (let i = 0; i < nChunks; i++) {
    const r = chunkResults[i];
    if (!r) break;
    all.push(...r);
  }
  return all;
}

/**
 * POSTs `items` to `endpoint` in batches of `batchSize`, with up to
 * `parallelBatches` requests in flight. Each response must be `{ results: [...] }`.
 *
 * Results come back in input order whatever order the batches finish in. A cancel
 * through `signal` resolves with the in-order prefix that completed. A non-2xx
 * response or a network error aborts the other in-flight batches and rejects with
 * the server's `error` message.
 *
 * @returns {Promise<{ results: any[]; cancelled: boolean }>}
 */
async function runInBatches({
  items,
  endpoint,
  buildBody,
  batchSize,
  parallelBatches,
  signal,
  onProgress,
}) {
  const total = items.length;
  const slices = [];
  for (let o = 0; o < total; o += batchSize) {
    slices.push(items.slice(o, o + batchSize));
  }
  const nChunks = slices.length;
  if (nChunks === 0) {
    return { results: [], cancelled: false };
  }

  const errorCtrl = new AbortController();
  const fetchSignal = anyAbortSignal([signal, errorCtrl.signal]);

  /** @type {any[][]} */
  const chunkResults = [];
  let doneCount = 0;
  let nextIndex = 0;
  /** @type {Error | null} */
  let hardError = null;

  async function worker() {
    for (;;) {
      if (signal.aborted) return;
      if (hardError) return;
      const i = nextIndex++;
      if (i >= nChunks) return;

      const slice = slices[i];
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: fetchSignal,
          body: JSON.stringify(buildBody(slice)),
        });
        const json = await res.json();
        if (!res.ok) {
          hardError = new Error(json.error || res.statusText);
          errorCtrl.abort();
          return;
        }
        chunkResults[i] = json.results || [];
        doneCount += slice.length;
        if (onProgress) onProgress(doneCount, total);
        await yieldToUi();
      } catch (e) {
        if (e.name === "AbortError") {
          return;
        }
        hardError = e instanceof Error ? e : new Error(String(e));
        errorCtrl.abort();
        return;
      }
    }
  }

  const poolSize = Math.min(parallelBatches, nChunks);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  const merged = mergeChunkResultsPrefix(chunkResults, nChunks);

  if (hardError) {
    throw hardError;
  }
  return { results: merged, cancelled: signal.aborted };
}

/** Flatten nested objects for CSV (dot keys). */
function flattenRecord(obj, prefix = "") {
  /** @type {Record<string, string>} */
  const out = {};
  if (obj === null || obj === undefined) {
    if (prefix) out[prefix] = "";
    return out;
  }
  if (typeof obj !== "object") {
    out[prefix || "value"] = formatCell(obj);
    return out;
  }
  if (Array.isArray(obj)) {
    out[prefix || "items"] = obj.map(formatCell).join("; ");
    return out;
  }
  for (const k of Object.keys(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flattenRecord(v, key));
    } else if (Array.isArray(v)) {
      out[key] = v.map(formatCell).join("; ");
    } else {
      out[key] = formatCell(v);
    }
  }
  return out;
}

function formatCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function resultsToRows(results) {
  /** @type {Record<string, string>[]} */
  const rows = [];
  for (const r of results) {
    const base = {
      input: r.input,
      ok: r.ok ? "true" : "false",
      error: r.ok ? "" : r.error || "",
      error_code: r.ok ? "" : String(r.code ?? ""),
    };
    if (r.ok && r.data) {
      const flat = flattenRecord(r.data);
      rows.push({ ...base, ...flat });
    } else {
      rows.push(base);
    }
  }
  return rows;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const allKeys = new Set();
  rows.forEach((row) => Object.keys(row).forEach((k) => allKeys.add(k)));
  const headers = Array.from(allKeys);
  const escape = (val) => {
    const s = val == null ? "" : String(val);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [
    headers.map(escape).join(","),
    ...rows.map((row) => headers.map((h) => escape(row[h] ?? "")).join(",")),
  ];
  return lines.join("\r\n");
}

function downloadCsv(text, filename) {
  const bom = "\uFEFF";
  const blob = new Blob([bom + text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* Requireable from node:test while staying a plain browser script. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    yieldToUi,
    parseCsv,
    stripBom,
    extractColumnFromCsvRows,
    uniqueLines,
    anyAbortSignal,
    mergeChunkResultsPrefix,
    runInBatches,
    flattenRecord,
    formatCell,
    resultsToRows,
    toCsv,
    downloadCsv,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all `batch.test.js` and `breakdown.test.js` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/batch.js test/batch.test.js
git commit -m "Add a shared batch runner and CSV helpers"
```

---

## Task 2: Lookup tab uses the shared batch module

**Files:**
- Modify: `assets/app.js`
- Modify: `assets/index.html:217-218`

**Interfaces:**
- Consumes: `runInBatches`, `parseCsv`, `stripBom`, `extractColumnFromCsvRows`, `uniqueLines`, `resultsToRows`, `toCsv`, `downloadCsv` from Task 1.
- Produces: nothing new. Lookup behaves as before.

- [ ] **Step 1: Load `batch.js` first**

In `assets/index.html`, replace:

```html
    <script src="/breakdown.js"></script>
    <script src="/app.js"></script>
```

with:

```html
    <script src="/batch.js"></script>
    <script src="/breakdown.js"></script>
    <script src="/app.js"></script>
```

- [ ] **Step 2: Delete the moved code from `assets/app.js`**

Delete these functions entirely: `yieldToUi`, `parseCsv`, `stripBom`, `extractPhonesFromCsvRows`, `uniquePhonesFromTextarea`, `anyAbortSignal`, `mergeChunkResultsPrefix`, `runLookupInChunks`, `runLookupSingle`, `flattenRecord`, `formatCell`, `resultsToRows`, `toCsv`, `downloadCsv`.

Also delete `summarizeLookupBodyForLog` and `logLookupResponse`. Nothing calls the first; the second builds an object and discards it. Both are dead code.

- [ ] **Step 3: Point the remaining callers at `batch.js`**

In `resolveNumbersForRun`, replace `const fromText = uniquePhonesFromTextarea();` with:

```js
  const fromText = uniqueLines(el("numbers").value);
```

In `refreshCsvFromInputs`, replace `parsedCsvNumbers = extractPhonesFromCsvRows(rows, col);` with:

```js
      parsedCsvNumbers = extractColumnFromCsvRows(rows, col);
```

In `runLookup`, replace everything from `const batchSize = getBatchSize();` down to the line before `lastResponse = results;` with:

```js
  const batchSize = getBatchSize();
  /** Single HTTP batch: brief delay before hiding progress so final req/s is readable. */
  const deferProgressHide = numbers.length <= batchSize;

  setStatus(
    skip > 0
      ? `Running… skipped first ${skip.toLocaleString()}; ${numbers.length.toLocaleString()} to process.`
      : "Running…"
  );
  if (progressHideTimeoutId != null) {
    clearTimeout(progressHideTimeoutId);
    progressHideTimeoutId = null;
  }
  lookupRunStartMs = Date.now();
  setProgressVisible(true, numbers.length, 0);
  el("runLookup").disabled = true;
  el("exportCsv").disabled = true;
  el("cancelLookup").hidden = false;
  el("cancelLookup").disabled = false;
  lookupAbortController = new AbortController();
  const { signal } = lookupAbortController;

  try {
    const { results, cancelled: batchCancelled } = await runInBatches({
      items: numbers,
      endpoint: LOOKUP_ENDPOINT,
      buildBody: buildLookupJsonBody,
      batchSize,
      parallelBatches: getParallelBatches(),
      signal,
      onProgress: (done, total) => {
        setProgressVisible(true, total, done);
        setStatus(
          `Running… ${done.toLocaleString()} / ${total.toLocaleString()} processed`
        );
      },
    });
```

The rest of `runLookup` (from `lastResponse = results;` on) is unchanged.

- [ ] **Step 4: Check syntax and tests**

Run: `for f in functions/*.js assets/*.js; do node --check "$f" || echo "FAIL $f"; done && npm test`
Expected: no `FAIL` lines; all tests PASS.

Run: `grep -nE "runLookupInChunks|runLookupSingle|extractPhonesFromCsvRows|uniquePhonesFromTextarea|logLookupResponse" assets/app.js`
Expected: no output.

- [ ] **Step 5: Manual check**

Run `npm run dev`, open `http://localhost:3000/index.html`, sign in, run a Lookup on 2 numbers, then on a 60-row CSV with batch size 25, then cancel a run midway. Expected: same table, progress bar, req/s line and status text as before this task.

- [ ] **Step 6: Commit**

```bash
git add assets/app.js assets/index.html
git commit -m "Run Lookup batches through the shared batch module"
```

---

## Task 3: `POST /email` Function

**Files:**
- Create: `functions/email.js`
- Test: `test/email-function.test.js`

**Interfaces:**
- Produces: `POST /email` taking JSON `{ apiKey: string, emails: string[] | string, source?: string, concurrency?: number }`, returning HTTP 200 `{ results: Array<{ input, ok: true, data } | { input, ok: false, error, code? }> }`, HTTP 400 `{ error }` for bad input, HTTP 401 `{ error }` for a rejected key. `data` is SendGrid's `result` object unmodified.

- [ ] **Step 1: Write the failing tests**

Create `test/email-function.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");

/** The Functions runtime provides Twilio.Response as a global. */
class FakeResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.body = undefined;
  }
  appendHeader(key, value) {
    this.headers[key] = value;
  }
  setStatusCode(code) {
    this.statusCode = code;
  }
  setBody(body) {
    this.body = body;
  }
}
global.Twilio = { Response: FakeResponse };

const { handler } = require("../functions/email.js");

const KEY_REJECTED =
  "SendGrid rejected the API key. It needs the Email Address Validation scope, which is available on Email API Pro and Premier plans only.";

function invoke(event) {
  return new Promise((resolve, reject) => {
    handler({}, event, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

/** Replaces global fetch for one test. `respond(email, attempt)` returns [status, body]. */
function stubSendgrid(t, respond) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const attempt = calls.filter((c) => c.body.email === body.email).length;
    calls.push({ url, init, body });
    const [status, payload] = await respond(body.email, attempt);
    return new Response(
      typeof payload === "string" ? payload : JSON.stringify(payload),
      { status }
    );
  };
  t.after(() => {
    global.fetch = original;
  });
  return calls;
}

function validResult(email) {
  const [local, host] = email.split("@");
  return {
    result: {
      email,
      verdict: "Valid",
      score: 0.97,
      local,
      host,
      checks: {
        domain: {
          has_valid_address_syntax: true,
          has_mx_or_a_record: true,
          is_suspected_disposable_address: false,
        },
        local_part: { is_suspected_role_address: false },
        additional: { has_known_bounces: false, has_suspected_bounces: false },
      },
      ip_address: "192.0.2.1",
    },
  };
}

test("splits, trims and de-duplicates, one request per address", async (t) => {
  const calls = stubSendgrid(t, (email) => [200, validResult(email)]);
  const res = await invoke({
    apiKey: "SG.test",
    emails: " a@example.com \nb@example.com,a@example.com",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    res.body.results.map((r) => r.input),
    ["a@example.com", "b@example.com"]
  );
  assert.deepEqual(res.body.results[0], {
    input: "a@example.com",
    ok: true,
    data: validResult("a@example.com").result,
  });
});

test("sends the key as a bearer token and passes source through", async (t) => {
  const calls = stubSendgrid(t, (email) => [200, validResult(email)]);
  await invoke({ apiKey: " SG.test ", emails: ["a@example.com"], source: "signup" });
  assert.equal(calls[0].url, "https://api.sendgrid.com/v3/validations/email");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer SG.test");
  assert.deepEqual(calls[0].body, { email: "a@example.com", source: "signup" });
});

test("omits source when none is given", async (t) => {
  const calls = stubSendgrid(t, (email) => [200, validResult(email)]);
  await invoke({ apiKey: "SG.test", emails: ["a@example.com"] });
  assert.deepEqual(calls[0].body, { email: "a@example.com" });
});

test("400 for an empty list, a missing key, or a bad source", async (t) => {
  const calls = stubSendgrid(t, (email) => [200, validResult(email)]);

  const empty = await invoke({ apiKey: "SG.test", emails: " \n, " });
  assert.equal(empty.statusCode, 400);
  assert.deepEqual(empty.body, { error: "Provide at least one email address." });

  const noKey = await invoke({ emails: ["a@example.com"] });
  assert.equal(noKey.statusCode, 400);
  assert.deepEqual(noKey.body, { error: "A SendGrid API key is required." });

  const badSource = await invoke({
    apiKey: "SG.test",
    emails: ["a@example.com"],
    source: "sign-up!",
  });
  assert.equal(badSource.statusCode, 400);
  assert.match(badSource.body.error, /letters, digits and spaces/);

  assert.equal(calls.length, 0);
});

test("a per-address error does not fail the batch", async (t) => {
  stubSendgrid(t, (email) =>
    email === "bad@"
      ? [400, { errors: [{ field: "email", message: "invalid email" }] }]
      : [200, validResult(email)]
  );
  const res = await invoke({ apiKey: "SG.test", emails: ["a@example.com", "bad@"] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results[0].ok, true);
  assert.deepEqual(res.body.results[1], {
    input: "bad@",
    ok: false,
    error: "invalid email",
    code: 400,
  });
});

test("a 401 from SendGrid becomes HTTP 401 with SendGrid's message appended", async (t) => {
  stubSendgrid(t, () => [401, { errors: [{ message: "authorization required" }] }]);
  const res = await invoke({ apiKey: "SG.bad", emails: ["a@example.com"] });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, `${KEY_REJECTED} SendGrid said: authorization required`);
});

test("a 403 with no SendGrid message becomes HTTP 401 with the plain message", async (t) => {
  stubSendgrid(t, () => [403, ""]);
  const res = await invoke({ apiKey: "SG.bad", emails: ["a@example.com"] });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: KEY_REJECTED });
});

test("a 429 then a 200 succeeds after one retry", async (t) => {
  const calls = stubSendgrid(t, (email, attempt) =>
    attempt === 0 ? [429, { errors: [{ message: "too many requests" }] }] : [200, validResult(email)]
  );
  const res = await invoke({ apiKey: "SG.test", emails: ["a@example.com"] });
  assert.equal(calls.length, 2);
  assert.equal(res.body.results[0].ok, true);
});

test("a 429 that persists is retried twice, then reported", async (t) => {
  const calls = stubSendgrid(t, () => [429, { errors: [{ message: "too many requests" }] }]);
  const res = await invoke({ apiKey: "SG.test", emails: ["a@example.com"] });
  assert.equal(calls.length, 3);
  assert.deepEqual(res.body.results[0], {
    input: "a@example.com",
    ok: false,
    error: "too many requests",
    code: 429,
  });
});

test("an upstream timeout is reported on that row only", async (t) => {
  stubSendgrid(t, (email) => {
    if (email === "slow@example.com") {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }
    return [200, validResult(email)];
  });
  const res = await invoke({
    apiKey: "SG.test",
    emails: ["slow@example.com", "a@example.com"],
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.results[0], {
    input: "slow@example.com",
    ok: false,
    error: "SendGrid did not respond in time.",
  });
  assert.equal(res.body.results[1].ok, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/email-function.test.js`
Expected: FAIL with `Cannot find module '../functions/email.js'`

- [ ] **Step 3: Write `functions/email.js`**

```js
/**
 * POST /email — validates email addresses with SendGrid's Email Address Validation
 * API, one request per address.
 *
 * The caller's SendGrid API key arrives in the body. No Twilio token is fetched:
 * the OAuth sign-in gate is enforced by the UI only, and the SendGrid key is the
 * credential that matters here.
 * See https://www.twilio.com/docs/sendgrid/api-reference/email-address-validation/validate-an-email
 */

const VALIDATE_URL = "https://api.sendgrid.com/v3/validations/email";

/** Per-request ceiling, so one slow upstream call cannot stall its chunk. */
const REQUEST_TIMEOUT_MS = 4000;

/**
 * Whole-invocation ceiling, inside the 10s Function timeout. Per-request timeouts
 * alone do not bound a batch: 5 rounds of 4s is 20s. A request that would start,
 * or a retry that would wait, past this point is reported as timed out instead.
 */
const BUDGET_MS = 8500;

/** Waits before the first and second retry of a 429. */
const RETRY_DELAYS_MS = [250, 750];

const KEY_REJECTED =
  "SendGrid rejected the API key. It needs the Email Address Validation scope, which is available on Email API Pro and Premier plans only.";
const TIMED_OUT = "SendGrid did not respond in time.";

/** SendGrid describes `source` as a one-word classifier. */
const SOURCE_PATTERN = /^[A-Za-z0-9 ]*$/;

function httpFallback(status) {
  return `SendGrid returned HTTP ${status}.`;
}

/** SendGrid errors look like `{ errors: [{ field, message }] }`. */
function sendgridErrorMessage(status, rawBody) {
  try {
    const message = JSON.parse(rawBody)?.errors?.[0]?.message;
    if (message) return message;
  } catch {
    /* not JSON */
  }
  return httpFallback(status);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function validateOne(email, { apiKey, source, deadline }) {
  const body = JSON.stringify(source ? { email, source } : { email });

  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { input: email, ok: false, error: TIMED_OUT };

    let status;
    let text;
    try {
      const res = await fetch(VALIDATE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
      return {
        input: email,
        ok: false,
        error: timedOut ? TIMED_OUT : err.message || String(err),
      };
    }

    if (status === 429 && attempt < RETRY_DELAYS_MS.length) {
      const wait = RETRY_DELAYS_MS[attempt];
      if (Date.now() + wait < deadline) {
        await sleep(wait);
        continue;
      }
    }

    if (status < 200 || status >= 300) {
      return {
        input: email,
        ok: false,
        error: sendgridErrorMessage(status, text),
        code: status,
      };
    }

    try {
      return { input: email, ok: true, data: JSON.parse(text).result };
    } catch {
      return {
        input: email,
        ok: false,
        error: "SendGrid returned a response that is not JSON.",
        code: status,
      };
    }
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const chunkResults = await Promise.all(chunk.map((item) => fn(item)));
    results.push(...chunkResults);
  }
  return results;
}

exports.handler = async function (context, event, callback) {
  const deadline = Date.now() + BUDGET_MS;
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");

  const raw = event.emails;
  const lines = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\r\n,]+/)
      : [];
  const emails = [
    ...new Set(lines.map((e) => String(e).trim()).filter((e) => e.length > 0)),
  ];

  if (!emails.length) {
    response.setStatusCode(400);
    response.setBody({ error: "Provide at least one email address." });
    return callback(null, response);
  }

  const apiKey = String(event.apiKey || "").trim();
  if (!apiKey) {
    response.setStatusCode(400);
    response.setBody({ error: "A SendGrid API key is required." });
    return callback(null, response);
  }

  const source = String(event.source || "").trim();
  if (!SOURCE_PATTERN.test(source)) {
    response.setStatusCode(400);
    response.setBody({ error: "source may contain only letters, digits and spaces." });
    return callback(null, response);
  }

  const concurrency = Math.min(Math.max(Number(event.concurrency) || 5, 1), 7);

  const results = await mapWithConcurrency(emails, concurrency, (email) =>
    validateOne(email, { apiKey, source, deadline })
  );

  // A rejected key fails every address the same way, so report it once and let
  // the UI stop the run — the same way a bad OAuth secret behaves on /lookup.
  const rejected = results.find((r) => r.code === 401 || r.code === 403);
  if (rejected) {
    const detail =
      rejected.error !== httpFallback(rejected.code)
        ? ` SendGrid said: ${rejected.error}`
        : "";
    response.setStatusCode(401);
    response.setBody({ error: KEY_REJECTED + detail });
    return callback(null, response);
  }

  response.setBody({ results });
  return callback(null, response);
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS (the persistent-429 test takes about 1 s).

- [ ] **Step 5: Commit**

```bash
git add functions/email.js test/email-function.test.js
git commit -m "Add a POST /email Function backed by SendGrid validation"
```

---

## Task 4: Tab bar and Email panel markup

**Files:**
- Modify: `assets/index.html` (header, new tab bar, Lookup `<main>`, new Email `<main>`, script tags)
- Modify: `assets/app.js` (new `SENDGRID_STORAGE_KEY`, `TAB_STORAGE_KEY`, `selectTab`, `initTabs`; `signOut`)
- Modify: `assets/styles.css` (append)

**Interfaces:**
- Produces: global `SENDGRID_STORAGE_KEY = "twilio_lookup_sendgrid"` in `app.js`, read by Task 5. Email panel element IDs used by Task 5: `emailApiKey`, `emailForgetKey`, `emailList`, `emailCsvFile`, `emailCsvColumn`, `emailBatchSize`, `emailParallelBatches`, `emailSkipRecords`, `emailCsvMeta`, `emailSource`, `emailConcurrency`, `emailRun`, `emailCancel`, `emailExport`, `emailProgressWrap`, `emailProgress`, `emailProgressLabel`, `emailThroughput`, `emailStatus`, `emailResultCount`, `emailResultsBody`, `emailPreviewNote`, `emailRawJson`. CSS classes `verdict--valid`, `verdict--risky`, `verdict--invalid`.

- [ ] **Step 1: Header variants and tab bar**

In `assets/index.html`, replace the whole `<header class="header">…</header>` block with:

```html
        <header class="header">
          <div class="header__title" data-tab-header="lookup">
            <h1>Lookup v2</h1>
            <p class="header__subtitle">
              Bulk phone validation and optional data packages. Charges apply when
              paid fields are requested — see
              <a
                href="https://www.twilio.com/docs/lookup/v2-api"
                target="_blank"
                rel="noreferrer"
                >Lookup v2 API docs</a
              >.
            </p>
          </div>
          <div class="header__title" data-tab-header="email" hidden>
            <h1>Email validation</h1>
            <p class="header__subtitle">
              Bulk email address validation with SendGrid. Each address is one
              billable validation — see
              <a
                href="https://www.twilio.com/docs/sendgrid/api-reference/email-address-validation/validate-an-email"
                target="_blank"
                rel="noreferrer"
                >Email Address Validation API docs</a
              >.
            </p>
          </div>
        </header>

        <div class="tabs" role="tablist" aria-label="Tool">
          <button type="button" class="tab" role="tab" id="tabLookup" data-tab="lookup" aria-controls="panelLookup" aria-selected="true">Lookup</button>
          <button type="button" class="tab" role="tab" id="tabEmail" data-tab="email" aria-controls="panelEmail" aria-selected="false" tabindex="-1">Email</button>
        </div>
```

- [ ] **Step 2: Make the Lookup layout a tab panel**

Replace `<main class="layout">` with:

```html
        <main class="layout" id="panelLookup" role="tabpanel" aria-labelledby="tabLookup">
```

Its contents do not change.

- [ ] **Step 3: Add the Email panel**

Directly after the Lookup panel's closing `</main>`, insert:

```html
        <main class="layout" id="panelEmail" role="tabpanel" aria-labelledby="tabEmail" hidden>
          <section class="panel panel--input">
            <h2>SendGrid API key</h2>
            <p class="hint">Needs an API key with the Email Address Validation scope (Email API Pro or Premier).</p>
            <div class="key-row">
              <label class="field key-row__field">
                <span>API key</span>
                <input type="password" id="emailApiKey" placeholder="SG.…" spellcheck="false" autocomplete="off" />
              </label>
              <button type="button" class="btn" id="emailForgetKey">Forget key</button>
            </div>

            <div class="panel-section">
              <h2>Email addresses</h2>
              <p class="hint">One address per line, or comma-separated. Duplicates are removed.</p>
              <textarea
                id="emailList"
                rows="12"
                placeholder="ada@example.com&#10;grace@example.org&#10;…"
                spellcheck="false"
              ></textarea>
            </div>

            <div class="csv-block">
              <h2 class="csv-block__title">CSV upload (large batches)</h2>
              <p class="hint">
                Upload a CSV; addresses are read from the column you choose (quoted fields supported).
              </p>
              <div class="row row--gap csv-row">
                <label class="field-inline field-inline--grow">
                  <span>CSV file</span>
                  <input type="file" id="emailCsvFile" accept=".csv,text/csv,text/plain" />
                </label>
                <label class="field-inline">
                  <span>Email column (1 = first)</span>
                  <input type="number" id="emailCsvColumn" min="1" value="1" />
                </label>
                <label class="field-inline">
                  <span>Addresses per API batch</span>
                  <input type="number" id="emailBatchSize" min="1" max="50" value="30" title="Capped at 50 so a batch fits inside the 10s Function timeout" />
                </label>
                <label class="field-inline">
                  <span>Parallel batches</span>
                  <input type="number" id="emailParallelBatches" min="1" max="12" value="2" title="How many /email requests run at once" />
                </label>
                <label class="field-inline">
                  <span>Skip first N records</span>
                  <input
                    type="number"
                    id="emailSkipRecords"
                    min="0"
                    value="0"
                    title="After dedupe, in list order — resume a job by skipping rows you already processed"
                  />
                </label>
              </div>
              <p class="csv-meta" id="emailCsvMeta" aria-live="polite"></p>
            </div>

            <div class="row row--gap">
              <label class="field-inline">
                <span>Source (optional)</span>
                <input type="text" id="emailSource" placeholder="signup" maxlength="64" title="Letters, digits and spaces only. Shown in SendGrid's validation dashboard." />
              </label>
              <label class="field-inline">
                <span>Concurrent validations (per batch)</span>
                <input type="number" id="emailConcurrency" min="1" max="7" value="5" title="Parallel SendGrid calls inside each batch (capped at 7 by /email to stay under the 10s Function timeout)" />
              </label>
            </div>

            <p class="billing-note">Each address is one billable validation.</p>

            <div class="actions">
              <button type="button" class="btn btn--primary" id="emailRun">
                Run validation
              </button>
              <button type="button" class="btn" id="emailCancel" disabled hidden>
                Cancel
              </button>
              <button type="button" class="btn" id="emailExport" disabled>
                Export CSV
              </button>
            </div>
            <div class="progress-wrap" id="emailProgressWrap" hidden>
              <progress id="emailProgress" max="100" value="0"></progress>
              <span class="progress-label" id="emailProgressLabel">0 / 0</span>
            </div>
            <p class="throughput" id="emailThroughput" aria-live="polite" hidden>—</p>
            <p class="status" id="emailStatus" aria-live="polite"></p>
          </section>

          <section class="panel panel--results">
            <div class="results-header">
              <h2>Results</h2>
              <span class="badge" id="emailResultCount">0 rows</span>
            </div>
            <div class="table-wrap">
              <table class="results-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Verdict</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody id="emailResultsBody"></tbody>
              </table>
            </div>
            <p class="preview-note" id="emailPreviewNote" hidden></p>
            <details class="details raw-details">
              <summary>Raw JSON</summary>
              <pre id="emailRawJson" class="raw-json"></pre>
            </details>
          </section>
        </main>
```

- [ ] **Step 4: Tab switching and sign-out in `assets/app.js`**

Below `const CRED_STORAGE_KEY = "twilio_lookup_oauth";`, add:

```js
/** The Email tab's SendGrid key. Sign-out clears it along with the OAuth credentials. */
const SENDGRID_STORAGE_KEY = "twilio_lookup_sendgrid";
const TAB_STORAGE_KEY = "twilio_lookup_tab";
```

Replace `signOut` with:

```js
function signOut() {
  clearCreds();
  sessionStorage.removeItem(SENDGRID_STORAGE_KEY);
  el("loginClientId").value = "";
  el("loginClientSecret").value = "";
  el("emailApiKey").value = "";
  showLogin();
}
```

Directly above `initAuth();` at the bottom of the file, add:

```js
/** Shows one tab's panel and header; remembers it so a reload returns to it. */
function selectTab(name, focus = false) {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  if (!tabs.some((t) => t.dataset.tab === name)) name = tabs[0].dataset.tab;
  for (const tab of tabs) {
    const on = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    el(tab.getAttribute("aria-controls")).hidden = !on;
    if (on && focus) tab.focus();
  }
  document.querySelectorAll("[data-tab-header]").forEach((h) => {
    h.hidden = h.dataset.tabHeader !== name;
  });
  sessionStorage.setItem(TAB_STORAGE_KEY, name);
}

function initTabs() {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => selectTab(tab.dataset.tab));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const step = e.key === "ArrowRight" ? 1 : -1;
      selectTab(tabs[(i + step + tabs.length) % tabs.length].dataset.tab, true);
    });
  });
  selectTab(sessionStorage.getItem(TAB_STORAGE_KEY));
}
```

Then change the init lines to:

```js
initAuth();
initTabs();
initFieldCheckboxes();
initIdentityFields();
```

- [ ] **Step 5: Styles**

Append to `assets/styles.css`:

```css
/* ---------------------------------------------------------------------------
   Tabs — Lookup / Email
   --------------------------------------------------------------------------- */
.tabs {
  display: flex;
  gap: 0.25rem;
  margin: -0.5rem 0 1.5rem;
  border-bottom: 1px solid var(--border);
}

.tab {
  font-family: var(--font);
  font-size: 0.85rem;
  font-weight: 600;
  padding: 0.6rem 1rem;
  margin-bottom: -1px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
}

.tab:hover {
  color: var(--text);
}

.tab[aria-selected="true"] {
  color: var(--twilio-red);
  border-bottom-color: var(--twilio-red);
}

.tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  border-radius: var(--radius) var(--radius) 0 0;
}

/* ---------------------------------------------------------------------------
   Email tab
   --------------------------------------------------------------------------- */
.key-row {
  display: flex;
  align-items: flex-end;
  gap: 0.65rem;
}

.key-row__field {
  flex: 1;
}

.panel-section {
  margin-top: 1.25rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--border);
}

.billing-note {
  margin: 1rem 0 0;
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--warning);
}

/* The verdict word is always shown, so colour is never the only signal. */
.verdict--valid {
  color: var(--success);
  font-weight: 600;
}

.verdict--risky {
  color: var(--warning);
  font-weight: 600;
}

.verdict--invalid {
  color: var(--danger);
  font-weight: 600;
}
```

- [ ] **Step 6: Check syntax and tests**

Run: `for f in functions/*.js assets/*.js; do node --check "$f" || echo "FAIL $f"; done && npm test`
Expected: no `FAIL` lines; all tests PASS.

- [ ] **Step 7: Manual check**

Run `npm run dev`, sign in. Expected: **Lookup** and **Email** tabs under the header. Clicking **Email** shows the Email panel and the "Email validation" heading. With focus on a tab, Left/Right switch tabs. Reload: the Email tab stays selected. The Email panel's buttons do nothing yet. The Lookup tab still runs.

- [ ] **Step 8: Commit**

```bash
git add assets/index.html assets/app.js assets/styles.css
git commit -m "Add Lookup and Email tabs with the Email panel markup"
```

---

## Task 5: Email tab behaviour

**Files:**
- Create: `assets/email.js`
- Test: `test/email-summary.test.js`
- Modify: `assets/index.html` (script tag)

**Interfaces:**
- Consumes: `runInBatches`, `parseCsv`, `stripBom`, `extractColumnFromCsvRows`, `uniqueLines`, `resultsToRows`, `toCsv`, `downloadCsv` (Task 1); `el`, `SENDGRID_STORAGE_KEY`, `TABLE_PREVIEW_LIMIT`, `RAW_JSON_PREVIEW_ROWS` (`app.js`); the element IDs and CSS classes from Task 4; `POST /email` from Task 3.
- Produces: `summarizeEmailResult(data) → string` and `emailVerdict(result) → { label: string, className: string }`, exported for tests.

- [ ] **Step 1: Write the failing tests**

Create `test/email-summary.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");

const { summarizeEmailResult, emailVerdict } = require("../assets/email.js");

function result(overrides = {}) {
  return {
    email: "a@example.com",
    verdict: "Valid",
    score: 0.97321,
    checks: {
      domain: {
        has_valid_address_syntax: true,
        has_mx_or_a_record: true,
        is_suspected_disposable_address: false,
      },
      local_part: { is_suspected_role_address: false },
      additional: { has_known_bounces: false, has_suspected_bounces: false },
    },
    ...overrides,
  };
}

test("a clean address shows only its score", () => {
  assert.equal(summarizeEmailResult(result()), "0.97");
});

test("every raised flag is listed in a fixed order, then the suggestion", () => {
  const data = result({
    score: 0.1,
    suggestion: "gmail.com",
    checks: {
      domain: {
        has_valid_address_syntax: false,
        has_mx_or_a_record: false,
        is_suspected_disposable_address: true,
      },
      local_part: { is_suspected_role_address: true },
      additional: { has_known_bounces: true, has_suspected_bounces: true },
    },
  });
  assert.equal(
    summarizeEmailResult(data),
    "0.10 · disposable · role address · no MX/A record · bad syntax · known bounces · suspected bounces · did you mean gmail.com?"
  );
});

test("missing checks are not reported as failures", () => {
  assert.equal(summarizeEmailResult({ verdict: "Risky", score: 0.5 }), "0.50");
  assert.equal(summarizeEmailResult(null), "—");
});

test("emailVerdict maps SendGrid verdicts and request errors to labels", () => {
  assert.deepEqual(emailVerdict({ ok: true, data: { verdict: "Valid" } }), {
    label: "Valid",
    className: "verdict--valid",
  });
  assert.deepEqual(emailVerdict({ ok: true, data: { verdict: "Risky" } }), {
    label: "Risky",
    className: "verdict--risky",
  });
  assert.deepEqual(emailVerdict({ ok: true, data: { verdict: "Invalid" } }), {
    label: "Invalid",
    className: "verdict--invalid",
  });
  assert.deepEqual(emailVerdict({ ok: false, error: "x" }), {
    label: "Error",
    className: "verdict--invalid",
  });
  assert.deepEqual(emailVerdict({ ok: true, data: {} }), { label: "—", className: "" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/email-summary.test.js`
Expected: FAIL with `Cannot find module '../assets/email.js'`

- [ ] **Step 3: Write `assets/email.js`**

```js
/**
 * Email tab — bulk address validation through POST /email (SendGrid).
 *
 * Batching and CSV handling come from batch.js; el(), SENDGRID_STORAGE_KEY and
 * the preview limits come from app.js, which loads first. Every top-level name
 * here carries "email" so it cannot replace an app.js function of the same name.
 * See docs/superpowers/specs/2026-10-08-email-validation-design.md
 */

const EMAIL_ENDPOINT = "/email";

let emailLastResults = null;
let emailParsedCsv = null;
let emailAbortController = null;
/** Wall-clock start for the current run (validations completed / elapsed). */
let emailRunStartMs = 0;
let emailProgressHideTimeoutId = null;

function getSendgridKey() {
  return (sessionStorage.getItem(SENDGRID_STORAGE_KEY) || "").trim();
}

function saveSendgridKey() {
  const key = el("emailApiKey").value.trim();
  if (key) sessionStorage.setItem(SENDGRID_STORAGE_KEY, key);
  else sessionStorage.removeItem(SENDGRID_STORAGE_KEY);
}

function forgetSendgridKey() {
  sessionStorage.removeItem(SENDGRID_STORAGE_KEY);
  el("emailApiKey").value = "";
}

/** Capped at 50 so one batch fits inside the 10s Function timeout. */
function getEmailBatchSize() {
  const n = Number(el("emailBatchSize").value) || 30;
  return Math.min(50, Math.max(1, Math.floor(n)));
}

function getEmailParallelBatches() {
  const n = Number(el("emailParallelBatches").value) || 2;
  return Math.min(12, Math.max(1, Math.floor(n)));
}

/** Records to skip from the start after dedupe, in list order (resume jobs). */
function getEmailSkipCount() {
  const n = Number(el("emailSkipRecords").value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 10_000_000);
}

function buildEmailBody(slice) {
  /** Mirrors the cap in functions/email.js. */
  const concurrency = Math.min(
    7,
    Math.max(1, Number(el("emailConcurrency").value) || 5)
  );
  const source = el("emailSource").value.trim();
  return {
    emails: slice,
    apiKey: getSendgridKey(),
    source: source || undefined,
    concurrency,
  };
}

function setEmailStatus(message, isError = false) {
  const s = el("emailStatus");
  s.textContent = message;
  s.className = isError ? "status error" : "status";
}

function setEmailProgress(visible, total = 0, done = 0) {
  const tput = el("emailThroughput");
  el("emailProgressWrap").hidden = !visible;
  tput.hidden = !visible;
  if (!visible) {
    emailRunStartMs = 0;
    tput.textContent = "—";
    return;
  }
  const bar = el("emailProgress");
  bar.max = Math.max(1, total);
  bar.value = done;
  el("emailProgressLabel").textContent =
    total > 0 ? `${done.toLocaleString()} / ${total.toLocaleString()}` : "…";
  const sec = (Date.now() - emailRunStartMs) / 1000;
  tput.textContent =
    emailRunStartMs && done > 0 && sec >= 0.35
      ? `${(done / sec).toFixed(1)} validations/s (avg since start)`
      : "—";
}

/** Score, then each check that raised a concern, then SendGrid's typo suggestion. */
function summarizeEmailResult(data) {
  if (!data) return "—";
  const domain = data.checks?.domain || {};
  const local = data.checks?.local_part || {};
  const additional = data.checks?.additional || {};
  const parts = [];
  if (typeof data.score === "number") parts.push(data.score.toFixed(2));
  if (domain.is_suspected_disposable_address === true) parts.push("disposable");
  if (local.is_suspected_role_address === true) parts.push("role address");
  if (domain.has_mx_or_a_record === false) parts.push("no MX/A record");
  if (domain.has_valid_address_syntax === false) parts.push("bad syntax");
  if (additional.has_known_bounces === true) parts.push("known bounces");
  if (additional.has_suspected_bounces === true) parts.push("suspected bounces");
  if (data.suggestion) parts.push(`did you mean ${data.suggestion}?`);
  return parts.join(" · ") || "—";
}

const EMAIL_VERDICT_CLASSES = {
  Valid: "verdict--valid",
  Risky: "verdict--risky",
  Invalid: "verdict--invalid",
};

/** Verdict cell text and colour. A failed request reads "Error", coloured as Invalid. */
function emailVerdict(result) {
  if (!result.ok) return { label: "Error", className: "verdict--invalid" };
  const verdict = result.data?.verdict;
  return {
    label: verdict || "—",
    className: EMAIL_VERDICT_CLASSES[verdict] || "",
  };
}

function renderEmailTable(results) {
  const tbody = el("emailResultsBody");
  tbody.innerHTML = "";
  results.slice(0, TABLE_PREVIEW_LIMIT).forEach((r) => {
    const tr = document.createElement("tr");

    // cell-phone is the shared "click to expand JSON" style, not phone-specific.
    const emailTd = document.createElement("td");
    emailTd.className = "cell-phone";
    emailTd.textContent = r.input;
    tr.appendChild(emailTd);

    const verdict = emailVerdict(r);
    const verdictTd = document.createElement("td");
    verdictTd.className = verdict.className;
    verdictTd.textContent = verdict.label;
    tr.appendChild(verdictTd);

    const summaryTd = document.createElement("td");
    summaryTd.textContent = r.ok
      ? summarizeEmailResult(r.data)
      : (r.error || "Error").slice(0, 200);
    tr.appendChild(summaryTd);

    tbody.appendChild(tr);

    const detailTr = document.createElement("tr");
    detailTr.className = "detail-row";
    detailTr.hidden = true;
    const detailTd = document.createElement("td");
    detailTd.colSpan = 3;
    const pre = document.createElement("pre");
    pre.className = "detail-row__json";
    pre.textContent = JSON.stringify(
      r.ok ? r.data : { error: r.error, code: r.code },
      null,
      2
    );
    detailTd.appendChild(pre);
    detailTr.appendChild(detailTd);
    tbody.appendChild(detailTr);

    emailTd.addEventListener("click", () => {
      const opening = detailTr.hidden;
      detailTr.hidden = !detailTr.hidden;
      emailTd.classList.toggle("cell-phone--open", opening);
    });
  });

  const total = results.length;
  el("emailResultCount").textContent = `${total.toLocaleString()} row${total === 1 ? "" : "s"}`;
  const note = el("emailPreviewNote");
  if (total > TABLE_PREVIEW_LIMIT) {
    note.hidden = false;
    note.textContent = `Showing first ${TABLE_PREVIEW_LIMIT.toLocaleString()} rows in the table. Export CSV for the full ${total.toLocaleString()} results.`;
  } else {
    note.hidden = true;
    note.textContent = "";
  }
  const raw = el("emailRawJson");
  if (total === 0) {
    raw.textContent = "";
  } else if (total <= RAW_JSON_PREVIEW_ROWS) {
    raw.textContent = JSON.stringify(results, null, 2);
  } else {
    raw.textContent =
      `/* Preview: first ${RAW_JSON_PREVIEW_ROWS} of ${total} — use Export CSV for everything */\n` +
      JSON.stringify(results.slice(0, RAW_JSON_PREVIEW_ROWS), null, 2);
  }
}

function resolveEmailsForRun() {
  const fileInput = el("emailCsvFile");
  if (fileInput.files && fileInput.files.length > 0) {
    if (!emailParsedCsv || emailParsedCsv.length === 0) {
      throw new Error(
        "Choose a valid CSV or wait for it to finish loading. No email addresses found."
      );
    }
    return emailParsedCsv;
  }
  const fromText = uniqueLines(el("emailList").value);
  if (!fromText.length) {
    throw new Error("Provide at least one email address or upload a CSV.");
  }
  return fromText;
}

async function runEmailValidation() {
  // "change" only fires on blur, so save whatever is in the box right now.
  saveSendgridKey();
  if (!getSendgridKey()) {
    setEmailStatus("Enter a SendGrid API key first.", true);
    return;
  }

  let emails;
  try {
    emails = resolveEmailsForRun();
  } catch (e) {
    setEmailStatus(e.message || String(e), true);
    return;
  }

  const skip = getEmailSkipCount();
  if (skip >= emails.length) {
    setEmailStatus(
      `Skip (${skip.toLocaleString()}) must be less than the number of records (${emails.length.toLocaleString()}).`,
      true
    );
    return;
  }
  if (skip > 0) emails = emails.slice(skip);

  const batchSize = getEmailBatchSize();
  /** Single HTTP batch: brief delay before hiding progress so final rate is readable. */
  const deferProgressHide = emails.length <= batchSize;

  setEmailStatus(
    skip > 0
      ? `Running… skipped first ${skip.toLocaleString()}; ${emails.length.toLocaleString()} to process.`
      : "Running…"
  );
  if (emailProgressHideTimeoutId != null) {
    clearTimeout(emailProgressHideTimeoutId);
    emailProgressHideTimeoutId = null;
  }
  emailRunStartMs = Date.now();
  setEmailProgress(true, emails.length, 0);
  el("emailRun").disabled = true;
  el("emailExport").disabled = true;
  el("emailCancel").hidden = false;
  el("emailCancel").disabled = false;
  emailAbortController = new AbortController();

  try {
    const { results, cancelled } = await runInBatches({
      items: emails,
      endpoint: EMAIL_ENDPOINT,
      buildBody: buildEmailBody,
      batchSize,
      parallelBatches: getEmailParallelBatches(),
      signal: emailAbortController.signal,
      onProgress: (done, total) => {
        setEmailProgress(true, total, done);
        setEmailStatus(
          `Running… ${done.toLocaleString()} / ${total.toLocaleString()} processed`
        );
      },
    });
    emailLastResults = results;
    renderEmailTable(results);
    el("emailExport").disabled = !results.length;
    const skipNote =
      skip > 0 ? `Skipped first ${skip.toLocaleString()} (not in this export). ` : "";
    if (cancelled) {
      setEmailStatus(
        results.length
          ? `${skipNote}Stopped. ${results.length.toLocaleString()} result(s) kept — export CSV if you need them.`
          : skip > 0
            ? `Cancelled after skipping ${skip.toLocaleString()}.`
            : "Cancelled."
      );
    } else {
      setEmailStatus(
        `${skipNote}Done. ${results.length.toLocaleString()} address(es) validated.`
      );
    }
  } catch (e) {
    const aborted = e.name === "AbortError";
    setEmailStatus(aborted ? "Cancelled." : e.message || String(e), !aborted);
    if (!aborted) {
      emailLastResults = null;
      renderEmailTable([]);
    }
  } finally {
    el("emailRun").disabled = false;
    el("emailCancel").hidden = true;
    el("emailCancel").disabled = true;
    emailAbortController = null;
    const hide = () => {
      emailProgressHideTimeoutId = null;
      setEmailProgress(false);
    };
    if (deferProgressHide) {
      emailProgressHideTimeoutId = setTimeout(hide, 450);
    } else {
      hide();
    }
  }
}

function exportEmailCsv() {
  if (!emailLastResults?.length) return;
  const csv = toCsv(resultsToRows(emailLastResults));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  downloadCsv(csv, `sendgrid-email-validation-${stamp}.csv`);
}

function refreshEmailCsv() {
  const fileInput = el("emailCsvFile");
  const meta = el("emailCsvMeta");
  if (!fileInput.files || fileInput.files.length === 0) {
    emailParsedCsv = null;
    meta.textContent = "";
    return;
  }
  const file = fileInput.files[0];
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rows = parseCsv(stripBom(String(reader.result || "")));
      const col = Number(el("emailCsvColumn").value) || 1;
      emailParsedCsv = extractColumnFromCsvRows(rows, col);
      if (!emailParsedCsv.length) {
        meta.textContent = `“${file.name}”: no values in column ${col}. Check “Email column”.`;
        return;
      }
      meta.textContent = `“${file.name}”: ${emailParsedCsv.length.toLocaleString()} unique address(es) in column ${col}.`;
    } catch (err) {
      emailParsedCsv = null;
      meta.textContent = `Could not parse CSV: ${err.message || err}`;
    }
  };
  reader.onerror = () => {
    emailParsedCsv = null;
    meta.textContent = "Could not read the file.";
  };
  reader.readAsText(file, "UTF-8");
}

function initEmailTab() {
  el("emailApiKey").value = getSendgridKey();
  el("emailApiKey").addEventListener("change", saveSendgridKey);
  el("emailForgetKey").addEventListener("click", forgetSendgridKey);
  el("emailRun").addEventListener("click", runEmailValidation);
  el("emailCancel").addEventListener("click", () => emailAbortController?.abort());
  el("emailExport").addEventListener("click", exportEmailCsv);
  el("emailCsvFile").addEventListener("change", refreshEmailCsv);
  el("emailCsvColumn").addEventListener("change", () => {
    if (el("emailCsvFile").files?.length) refreshEmailCsv();
  });
}

if (typeof document !== "undefined") initEmailTab();

/* Requireable from node:test while staying a plain browser script. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { summarizeEmailResult, emailVerdict };
}
```

- [ ] **Step 4: Load it last**

In `assets/index.html`, after `<script src="/app.js"></script>`, add:

```html
    <script src="/email.js"></script>
```

- [ ] **Step 5: Run checks**

Run: `for f in functions/*.js assets/*.js; do node --check "$f" || echo "FAIL $f"; done && npm test`
Expected: no `FAIL` lines; all tests PASS.

- [ ] **Step 6: Manual check**

Run `npm run dev`, sign in, open the **Email** tab.

1. Click **Run validation** with no key. Expected: `Enter a SendGrid API key first.`
2. Enter a key, leave the list empty, run. Expected: `Provide at least one email address or upload a CSV.`
3. Enter an invalid key and one address. Expected: the run stops with the key-rejected message.
4. With a real Email Address Validation key, run `ada@gmail.com`, `someone@gmial.com`, `bad@`. Expected: verdict colours, `did you mean …?` on the typo, a row error or Invalid for `bad@`. Click an email: its JSON expands.
5. **Export CSV**. Expected: `sendgrid-email-validation-<timestamp>.csv` with `checks.domain.*` columns.
6. Reload: the key and tab persist. **Sign out**, sign back in: the key field is empty.
7. Lookup tab: one run still works.

- [ ] **Step 7: Commit**

```bash
git add assets/email.js test/email-summary.test.js assets/index.html
git commit -m "Validate email addresses in bulk on the Email tab"
```

---

## Task 6: Docs

**Files:**
- Modify: `README.md`
- Modify: `docs/design.md`

- [ ] **Step 1: README**

After the `**Supported data packages:** …` line, add:

```markdown
**Email validation:** a second tab validates email addresses in bulk with SendGrid's [Email Address Validation API](https://www.twilio.com/docs/sendgrid/api-reference/email-address-validation/validate-an-email). It needs a SendGrid key of its own ([setup below](#sendgrid-email-validation)).
```

After the existing `> [!WARNING]` block about Lookup billing, add:

```markdown
> [!WARNING]
> **Each email address is one billable SendGrid validation.** Duplicates are removed first, but a 10,000-row list is still up to 10,000 validations.
```

Before the `## Usage` section's preceding `---`, add a new section:

```markdown
---

## SendGrid Email Validation

The **Email** tab calls SendGrid's Email Address Validation API with a SendGrid API key that you enter in the tab itself. You still sign in with the Twilio OAuth app first.

1. Email Address Validation is available on **Email API Pro and Premier** plans only. On other plans the option to create the key does not appear.
2. In the SendGrid console, go to **Settings › API Keys › Create API Key**.
3. Choose **Restricted Access** and grant **Email Address Validation**. Grant nothing else.
4. Copy the key (it starts with `SG.`) and paste it into the Email tab.

The key is kept in `sessionStorage` under `twilio_lookup_sendgrid`, the same exposure as the OAuth credentials. **Forget key** removes it, and so does **Sign out**. It is sent in the body of each `POST /email` request and never stored server-side.
```

In **Project structure**, replace the tree with:

```
twilio-lookup-api-ui/
├── .twilioserverlessrc  # Twilio Serverless config (functions/ + assets/ folders)
├── functions/
│   ├── email.js         # POST /email — validates addresses with SendGrid
│   ├── lookup.js        # POST /lookup — runs Lookup v2 queries
│   └── verify.js        # POST /verify — validates OAuth credentials
└── assets/              # Static frontend, served as Twilio Assets
    ├── index.html
    ├── batch.js         # batch runner + CSV helpers shared by both tabs
    ├── app.js           # auth, tabs, Lookup tab
    ├── email.js         # Email tab
    └── styles.css
```

- [ ] **Step 2: `docs/design.md`**

In **Shape**, change "two Functions" to "three Functions", and replace the tree with:

```
.twilioserverlessrc     runtime: node24, functions/ + assets/ folders
functions/
  verify.js             POST /verify  — validate OAuth credentials
  lookup.js             POST /lookup  — run Lookup v2 queries
  email.js              POST /email   — run SendGrid email validations
assets/
  index.html            login view + Lookup and Email tabs in one page
  batch.js              batch runner and CSV helpers shared by both tabs
  breakdown.js          Lookup results breakdown charts
  app.js                auth, tabs, Lookup tab
  email.js              Email tab
  styles.css
```

After the `/lookup` section, before `## Frontend`, add:

```markdown
### `POST /email`

Accepts JSON `{ apiKey, emails, source?, concurrency? }`. `apiKey` is the caller's SendGrid key with the Email Address Validation scope; no Twilio token is fetched, because the OAuth gate is enforced by the UI and the SendGrid key is the credential that matters here.

`emails` is split, trimmed and de-duplicated exactly like `numbers` on `/lookup`. An empty list, a missing key, or a `source` with anything other than letters, digits and spaces is a 400.

Each address is one `POST https://api.sendgrid.com/v3/validations/email` with `Authorization: Bearer <apiKey>`, run through the same `mapWithConcurrency` (1–7, default 5). Results have the `/lookup` shape, and `data` is SendGrid's `result` object unmodified:

```json
{ "input": "a@example.com", "ok": true,  "data": { "verdict": "Valid", "score": 0.97, "checks": { "…": "…" } } }
{ "input": "bad@",          "ok": false, "error": "…", "code": 400 }
```

Three limits keep a batch inside the 10-second Function timeout:

- Each request has a 4-second `AbortSignal.timeout`.
- A 429 is retried at most twice, after 250 ms and then 750 ms.
- The invocation has an 8.5-second budget. A request that would start, or a retry that would wait, past it is reported as `SendGrid did not respond in time.` Per-request timeouts alone do not bound a batch: 30 addresses at concurrency 7 is 5 rounds.

If any address comes back 401 or 403, the whole response is HTTP 401 with one "SendGrid rejected the API key…" message, with SendGrid's own message appended when present. The UI stops the run on it, as it does for a bad OAuth secret on `/lookup`.
```

In **Frontend**, after the **Auth** paragraph, add:

```markdown
**Tabs.** A `role="tablist"` under the header switches between the Lookup and Email panels; Left/Right arrows move between tabs. The active tab is kept in `sessionStorage` (`twilio_lookup_tab`) so a reload returns to it. Each tab has its own header text. The Email tab's SendGrid key is stored separately under `twilio_lookup_sendgrid`; sign-out clears it along with the OAuth key.
```

Replace the **Batching** paragraph's first sentence with:

```markdown
**Batching.** Both tabs run through `runInBatches` in `batch.js`. The list is chunked by batch size (Lookup: default 30, max 2000; Email: default 30, max 50) and sent as several requests, up to `parallelBatches` (default 2) in flight.
```

Keep the rest of that paragraph.

In **Security properties**, replace the "The Function URLs are public" bullet with:

```markdown
- **The Function URLs are public.** Anyone with the URL can use the tool, but only with OAuth credentials or a SendGrid key they already hold. The deployment holds no credentials of its own, so it cannot be used to spend the owner's balance or validation credits.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/design.md
git commit -m "Document the Email validation tab"
```
