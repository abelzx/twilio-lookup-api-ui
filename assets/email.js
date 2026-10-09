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
