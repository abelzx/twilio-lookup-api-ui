/** Twilio Lookup v2 field names (paid packages + optional extras per docs) */
const LOOKUP_FIELDS = [
  {
    id: "validation",
    label: "validation",
    description: "Explicit validation field (with other packages)",
  },
  { id: "caller_name", label: "caller_name", description: "CNAM (US)" },
  { id: "sim_swap", label: "sim_swap", description: "Last SIM change" },
  { id: "call_forwarding", label: "call_forwarding", description: "UK mobile" },
  { id: "line_status", label: "line_status", description: "Line status" },
  {
    id: "line_type_intelligence",
    label: "line_type_intelligence",
    description: "Mobile / landline / VoIP",
  },
  { id: "identity_match", label: "identity_match", description: "Name/address match" },
  {
    id: "reassigned_number",
    label: "reassigned_number",
    description: "Reassignment check",
  },
  {
    id: "sms_pumping_risk",
    label: "sms_pumping_risk",
    description: "SMS pumping risk",
  },
];

const IDENTITY_KEYS = [
  ["firstName", "First name"],
  ["lastName", "Last name"],
  ["addressLine1", "Address line 1"],
  ["addressLine2", "Address line 2"],
  ["city", "City"],
  ["state", "State / province"],
  ["postalCode", "Postal code"],
  ["addressCountryCode", "Address country (ISO)"],
  ["nationalId", "National ID"],
  ["dateOfBirth", "Date of birth (YYYYMMDD)"],
];

let lastResponse = null;

/** Table / JSON previews only — full data stays in memory for CSV export. */
const TABLE_PREVIEW_LIMIT = 400;
const RAW_JSON_PREVIEW_ROWS = 35;

const LOOKUP_ENDPOINT = "/lookup";
const VERIFY_ENDPOINT = "/verify";
const CRED_STORAGE_KEY = "twilio_lookup_oauth";

function loadCreds() {
  try {
    return JSON.parse(sessionStorage.getItem(CRED_STORAGE_KEY) || "{}");
  } catch { return {}; }
}

function saveCreds(creds) {
  sessionStorage.setItem(CRED_STORAGE_KEY, JSON.stringify(creds));
}

function clearCreds() {
  sessionStorage.removeItem(CRED_STORAGE_KEY);
}

function getCredsForRequest() {
  const c = loadCreds();
  return {
    clientId: c.clientId || undefined,
    clientSecret: c.clientSecret || undefined,
  };
}

/**
 * /verify reports the account the OAuth app acts on when it can read it out of the
 * access token; otherwise fall back to a truncated Client ID, which is still enough
 * to tell two apps apart.
 */
function accountLabel(creds) {
  if (creds.accountSid) return creds.accountSid;
  const id = creds.clientId || "";
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

async function login() {
  const clientId = el("loginClientId").value.trim();
  const clientSecret = el("loginClientSecret").value.trim();

  const errorEl = el("loginError");
  const btn = el("loginBtn");

  if (!clientId || !clientSecret) {
    showLoginError("Client ID and Client Secret are both required.");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Signing in…";
  errorEl.hidden = true;

  try {
    const formBody = new URLSearchParams();
    formBody.set("clientId", clientId);
    formBody.set("clientSecret", clientSecret);
    const res = await fetch(VERIFY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
    });
    let json;
    try {
      json = await res.json();
    } catch {
      showLoginError(`Unexpected response from server (HTTP ${res.status}).`);
      return;
    }
    if (json.valid) {
      const creds = { clientId, clientSecret, accountSid: json.accountSid };
      saveCreds(creds);
      showApp(accountLabel(creds));
    } else {
      showLoginError(json.error || "Sign in failed.");
    }
  } catch (e) {
    showLoginError("Network error — could not reach the server.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
}

function showLoginError(msg) {
  const e = el("loginError");
  e.textContent = msg;
  e.hidden = false;
}

function showLogin() {
  el("loginView").hidden = false;
  el("appView").hidden = true;
}

function showApp(label) {
  el("loginView").hidden = true;
  el("appView").hidden = false;
  const acct = el("topbarAccount");
  if (acct && label) acct.textContent = label;
  const signOut = el("signOutBtn");
  if (signOut) signOut.hidden = false;
}

function signOut() {
  clearCreds();
  el("loginClientId").value = "";
  el("loginClientSecret").value = "";
  showLogin();
}

function initAuth() {
  const creds = loadCreds();
  if (creds.clientId && creds.clientSecret) {
    showApp(accountLabel(creds));
  } else {
    showLogin();
  }
}

let parsedCsvNumbers = null;
let lookupAbortController = null;
/** Wall-clock start for current run (Twilio Lookup calls completed / elapsed). */
let lookupRunStartMs = 0;
let progressHideTimeoutId = null;

function el(id) {
  return document.getElementById(id);
}

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
function extractPhonesFromCsvRows(rows, columnOneBased) {
  const col = Math.max(1, Math.floor(columnOneBased)) - 1;
  const raw = [];
  for (const r of rows) {
    if (!r || col >= r.length) continue;
    const v = String(r[col] ?? "").trim();
    if (v) raw.push(v);
  }
  return [...new Set(raw)];
}

function uniquePhonesFromTextarea() {
  const raw = el("numbers").value;
  const lines = raw.split(/[\r\n,]+/);
  return [
    ...new Set(
      lines
        .map((n) => String(n).trim())
        .filter((n) => n.length > 0)
    ),
  ];
}

function getBatchSize() {
  const n = Number(el("batchSize").value) || 30;
  return Math.min(2000, Math.max(25, Math.floor(n)));
}

function getParallelBatches() {
  const inp = el("parallelBatches");
  const n = inp ? Number(inp.value) || 4 : 4;
  return Math.min(12, Math.max(1, Math.floor(n)));
}

/** Records to skip from the start after dedupe, in list order (resume jobs). */
function getSkipCount() {
  const inp = el("skipRecords");
  const raw = inp ? inp.value : "0";
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 10_000_000);
}

/** @param {AbortSignal[]} signals */
function anyAbortSignal(signals) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any(signals);
  }
  return signals[0];
}

/** Log-friendly copy of lookup body (truncate huge `numbers` arrays). */
function summarizeLookupBodyForLog(body) {
  const nums = body.numbers;
  const n = Array.isArray(nums) ? nums.length : 0;
  if (n <= 20) return body;
  return {
    ...body,
    numbers: [...nums.slice(0, 5), `… +${n - 5} more`],
    numbersCount: n,
  };
}

function logLookupResponse(res, json) {
  const results = json.results || [];
  const base = {
    httpStatus: res.status,
    ok: res.ok,
    error: json.error,
    resultsCount: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    fetchParams: json.fetchParams,
  };
}

function buildLookupJsonBody(numbersSlice) {
  const fields = getSelectedFields();
  const countryCode = el("countryCode").value.trim();
  /** Mirrors the cap in functions/lookup.js — the 10s Function timeout is the real limit. */
  const concurrency = Math.min(
    7,
    Math.max(1, Number(el("concurrency").value) || 5)
  );
  const lastVerifiedDate = el("lastVerifiedDate").value.trim();
  const partnerSubId = el("partnerSubId").value.trim();
  const identityMatch = getIdentityMatch();
  return {
    numbers: numbersSlice,
    fields,
    countryCode: countryCode || undefined,
    concurrency,
    lastVerifiedDate: lastVerifiedDate || undefined,
    partnerSubId: partnerSubId || undefined,
    identityMatch:
      Object.keys(identityMatch).length > 0 ? identityMatch : undefined,
    ...getCredsForRequest(),
  };
}

function updateThroughputDisplay(done) {
  const tput = el("throughputLabel");
  if (!tput) return;
  if (!lookupRunStartMs || done <= 0) {
    tput.textContent = "—";
    return;
  }
  const sec = (Date.now() - lookupRunStartMs) / 1000;
  if (sec < 0.35) {
    tput.textContent = "—";
    return;
  }
  const rps = done / sec;
  tput.textContent = `${rps.toFixed(1)} Lookup req/s (avg since start)`;
}

function setProgressVisible(visible, total = 0, done = 0) {
  const wrap = el("progressWrap");
  const bar = el("batchProgress");
  const label = el("progressLabel");
  const tput = el("throughputLabel");
  wrap.hidden = !visible;
  if (!visible) {
    lookupRunStartMs = 0;
    if (tput) {
      tput.hidden = true;
      tput.textContent = "—";
    }
    return;
  }
  if (tput) tput.hidden = false;
  bar.max = Math.max(1, total);
  bar.value = done;
  label.textContent =
    total > 0 ? `${done.toLocaleString()} / ${total.toLocaleString()}` : "…";
  updateThroughputDisplay(done);
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
 * Runs several HTTP batches in parallel (each batch does concurrent Twilio calls server-side).
 * @returns {Promise<{ results: any[]; cancelled: boolean }>}
 */
async function runLookupInChunks(numbers, signal) {
  const batchSize = getBatchSize();
  const total = numbers.length;
  const slices = [];
  for (let o = 0; o < numbers.length; o += batchSize) {
    slices.push(numbers.slice(o, o + batchSize));
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
        const body = buildLookupJsonBody(slice);
        const res = await fetch(LOOKUP_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: fetchSignal,
          body: JSON.stringify(body),
        });
        const json = await res.json();
        logLookupResponse(res, json);
        if (!res.ok) {
          hardError = new Error(json.error || res.statusText);
          errorCtrl.abort();
          return;
        }
        chunkResults[i] = json.results || [];
        doneCount += slice.length;
        setProgressVisible(true, total, doneCount);
        setStatus(
          `Running… ${doneCount.toLocaleString()} / ${total.toLocaleString()} processed`
        );
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

  const poolSize = Math.min(getParallelBatches(), nChunks);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  const merged = mergeChunkResultsPrefix(chunkResults, nChunks);

  if (hardError) {
    throw hardError;
  }
  if (signal.aborted) {
    return { results: merged, cancelled: true };
  }
  return { results: merged, cancelled: false };
}

async function runLookupSingle(numbers, signal) {
  const body = buildLookupJsonBody(numbers);
  const res = await fetch(LOOKUP_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify(body),
  });
  const json = await res.json();
  logLookupResponse(res, json);
  if (!res.ok) {
    throw new Error(json.error || res.statusText);
  }
  return json.results || [];
}

const DEFAULT_CHECKED_FIELDS = [
  "line_type_intelligence",
  "line_status",
  "sms_pumping_risk",
];

function initFieldCheckboxes() {
  const container = el("fieldOptions");
  LOOKUP_FIELDS.forEach((f) => {
    const label = document.createElement("label");
    label.className = "check";
    const checked = DEFAULT_CHECKED_FIELDS.includes(f.id) ? "checked" : "";
    label.innerHTML = `
      <input type="checkbox" name="fields" value="${f.id}" data-field ${checked} />
      <span><code>${f.label}</code> — ${f.description}</span>
    `;
    container.appendChild(label);
  });
}

function initIdentityFields() {
  const container = el("identityMatchFields");
  IDENTITY_KEYS.forEach(([key, title]) => {
    const wrap = document.createElement("label");
    wrap.className = "field";
    wrap.innerHTML = `<span>${title}</span><input type="text" data-im="${key}" />`;
    container.appendChild(wrap);
  });
}

function getSelectedFields() {
  return Array.from(document.querySelectorAll("[data-field]:checked")).map(
    (c) => c.value
  );
}

function getIdentityMatch() {
  const o = {};
  document.querySelectorAll("[data-im]").forEach((input) => {
    const key = input.getAttribute("data-im");
    const v = input.value.trim();
    if (v) o[key] = v;
  });
  return o;
}

function setStatus(message, isError = false) {
  const s = el("status");
  s.textContent = message;
  s.className = isError ? "status error" : "status";
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

function renderTable(results) {
  const tbody = el("resultsBody");
  tbody.innerHTML = "";
  const preview = results.slice(0, TABLE_PREVIEW_LIMIT);
  preview.forEach((r) => {
    const tr = document.createElement("tr");
    const summary = r.ok
      ? summarizeSuccess(r.data)
      : (r.error || "Error").slice(0, 200);

    const td = document.createElement("td");
    td.className = "cell-phone";
    td.textContent = r.input;
    tr.appendChild(td);

    const statusTd = document.createElement("td");
    statusTd.className = r.ok ? "cell-ok" : "cell-err";
    statusTd.textContent = r.ok ? "OK" : "Error";
    tr.appendChild(statusTd);

    const summaryTd = document.createElement("td");
    summaryTd.textContent = summary;
    tr.appendChild(summaryTd);

    tbody.appendChild(tr);

    const detailTr = document.createElement("tr");
    detailTr.className = "detail-row";
    detailTr.hidden = true;
    const detailTd = document.createElement("td");
    detailTd.colSpan = 3;
    const pre = document.createElement("pre");
    pre.className = "detail-row__json";
    pre.textContent = JSON.stringify(r.ok ? r.data : { error: r.error, code: r.code }, null, 2);
    detailTd.appendChild(pre);
    detailTr.appendChild(detailTd);
    tbody.appendChild(detailTr);

    td.addEventListener("click", () => {
      const opening = detailTr.hidden;
      detailTr.hidden = !detailTr.hidden;
      td.classList.toggle("cell-phone--open", opening);
    });
  });
  const total = results.length;
  el("resultCount").textContent = `${total.toLocaleString()} row${total === 1 ? "" : "s"}`;
  const note = el("previewNote");
  if (total > TABLE_PREVIEW_LIMIT) {
    note.hidden = false;
    note.textContent = `Showing first ${TABLE_PREVIEW_LIMIT.toLocaleString()} rows in the table. Export CSV for the full ${total.toLocaleString()} results.`;
  } else {
    note.hidden = true;
    note.textContent = "";
  }
  const raw = el("rawJson");
  if (total <= RAW_JSON_PREVIEW_ROWS) {
    raw.textContent = JSON.stringify(results, null, 2);
  } else {
    raw.textContent =
      `/* Preview: first ${RAW_JSON_PREVIEW_ROWS} of ${total} — use Export CSV for everything */\n` +
      JSON.stringify(results.slice(0, RAW_JSON_PREVIEW_ROWS), null, 2);
  }
}

function summarizeSuccess(data) {
  if (!data) return "—";
  const valid = data.valid;
  const nf = data.national_format || data.nationalFormat;
  const cc = data.country_code || data.countryCode;
  const parts = [];
  if (valid !== undefined) parts.push(`valid=${valid}`);
  if (nf) parts.push(nf);
  if (cc) parts.push(cc);
  return parts.join(" · ") || JSON.stringify(data).slice(0, 120);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resolveNumbersForRun() {
  const fileInput = el("csvFile");
  if (fileInput.files && fileInput.files.length > 0) {
    if (!parsedCsvNumbers || parsedCsvNumbers.length === 0) {
      throw new Error(
        "Choose a valid CSV or wait for it to finish loading. No phone numbers found."
      );
    }
    return parsedCsvNumbers;
  }
  const fromText = uniquePhonesFromTextarea();
  if (!fromText.length) {
    throw new Error("Provide at least one phone number or upload a CSV.");
  }
  return fromText;
}

async function runLookup() {
  let numbers;
  try {
    numbers = resolveNumbersForRun();
  } catch (e) {
    setStatus(e.message || String(e), true);
    return;
  }

  const totalBeforeSkip = numbers.length;
  const skip = getSkipCount();
  if (skip >= totalBeforeSkip) {
    setStatus(
      `Skip (${skip.toLocaleString()}) must be less than the number of records (${totalBeforeSkip.toLocaleString()}).`,
      true
    );
    return;
  }
  if (skip > 0) {
    numbers = numbers.slice(skip);
  }

  const batchSize = getBatchSize();
  const useChunks = numbers.length > batchSize;

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

  /** Single HTTP batch: brief delay before hiding progress so final req/s is readable. */
  let deferProgressHide = false;

  try {
    let results;
    let batchCancelled = false;
    if (useChunks) {
      const out = await runLookupInChunks(numbers, signal);
      results = out.results;
      batchCancelled = out.cancelled;
    } else {
      results = await runLookupSingle(numbers, signal);
      deferProgressHide = true;
      setProgressVisible(true, numbers.length, results.length);
    }
    lastResponse = results;
    renderTable(results);
    renderBreakdown(results, el("breakdownBlock"));
    el("exportCsv").disabled = !results.length;
    const skipNote =
      skip > 0 ? `Skipped first ${skip.toLocaleString()} (not in this export). ` : "";
    if (batchCancelled) {
      setStatus(
        results.length
          ? `${skipNote}Stopped. ${results.length.toLocaleString()} result(s) kept — export CSV if you need them.`
          : skip > 0
            ? `Cancelled after skipping ${skip.toLocaleString()}.`
            : "Cancelled."
      );
    } else {
      setStatus(
        `${skipNote}Done. ${results.length.toLocaleString()} number(s) processed.`
      );
    }
  } catch (e) {
    const aborted = e.name === "AbortError";
    setStatus(aborted ? "Cancelled." : e.message || String(e), !aborted);
    if (!aborted) {
      lastResponse = null;
      el("resultsBody").innerHTML = "";
      el("rawJson").textContent = "";
      el("resultCount").textContent = "0 rows";
      el("previewNote").hidden = true;
      clearBreakdown(el("breakdownBlock"));
    }
  } finally {
    el("runLookup").disabled = false;
    el("cancelLookup").hidden = true;
    el("cancelLookup").disabled = true;
    lookupAbortController = null;
    const hide = () => {
      progressHideTimeoutId = null;
      setProgressVisible(false);
    };
    if (deferProgressHide) {
      progressHideTimeoutId = setTimeout(hide, 450);
    } else {
      hide();
    }
  }
}

function cancelLookup() {
  lookupAbortController?.abort();
}

function exportCsv() {
  if (!lastResponse?.length) return;
  const rows = resultsToRows(lastResponse);
  const csv = toCsv(rows);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  downloadCsv(csv, `twilio-lookup-${stamp}.csv`);
}

function refreshCsvFromInputs() {
  const fileInput = el("csvFile");
  const meta = el("csvMeta");
  if (!fileInput.files || fileInput.files.length === 0) {
    parsedCsvNumbers = null;
    meta.textContent = "";
    return;
  }
  const file = fileInput.files[0];
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = stripBom(String(reader.result || ""));
      const rows = parseCsv(text);
      const col = Number(el("csvPhoneColumn").value) || 1;
      parsedCsvNumbers = extractPhonesFromCsvRows(rows, col);
      if (!parsedCsvNumbers.length) {
        meta.textContent = `“${file.name}”: no values in column ${col}. Check “Phone column”.`;
        return;
      }
      meta.textContent = `“${file.name}”: ${parsedCsvNumbers.length.toLocaleString()} unique number(s) in column ${col}.`;
    } catch (err) {
      parsedCsvNumbers = null;
      meta.textContent = `Could not parse CSV: ${err.message || err}`;
    }
  };
  reader.onerror = () => {
    parsedCsvNumbers = null;
    meta.textContent = "Could not read the file.";
  };
  reader.readAsText(file, "UTF-8");
}

initAuth();
initFieldCheckboxes();
initIdentityFields();

el("loginBtn").addEventListener("click", login);
el("loginClientId").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
el("loginClientSecret").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
el("signOutBtn").addEventListener("click", signOut);

el("runLookup").addEventListener("click", runLookup);
el("exportCsv").addEventListener("click", exportCsv);
el("cancelLookup").addEventListener("click", cancelLookup);
el("csvFile").addEventListener("change", refreshCsvFromInputs);
el("csvPhoneColumn").addEventListener("change", () => {
  if (el("csvFile").files?.length) refreshCsvFromInputs();
});

