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
