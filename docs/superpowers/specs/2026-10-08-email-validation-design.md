# Email validation tab — design

**Date:** 2026-10-08
**Status:** approved, ready for implementation planning

## Problem

The tool validates phone numbers in bulk but not email addresses. Teams cleaning a
contact list need both. SendGrid's
[Email Address Validation API](https://www.twilio.com/docs/sendgrid/api-reference/email-address-validation/validate-an-email)
covers email, one address per request, so it fits the same bulk-batching model the
Lookup tab already uses.

## Solution summary

A second tab, **Email**, next to the existing Lookup view. It takes a pasted list or
a CSV column of addresses, validates each through a new `POST /email` Function, and
shows a results table with CSV export. The batch runner that drives Lookup moves into
a shared module so both tabs use one code path.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where the SendGrid key is entered | Inside the Email tab | Lookup-only users never see it. The login screen stays a single-credential form. |
| Key storage | `sessionStorage`, key `twilio_lookup_sendgrid` | Same exposure model as the OAuth credentials. A server-side env var would break the "app holds no credentials of its own" property and let anyone with the URL spend the owner's validation credits. |
| Login gate | Unchanged — Twilio OAuth sign-in still required | Smallest diff. Email-only users still need an OAuth app; accepted. |
| Scope | Bulk: textarea, CSV, batching, cancel, export | Matches the Lookup tab. No breakdown chart in this iteration. |
| Code structure | Extract a shared batch runner (`assets/batch.js`) | One batching implementation instead of two that drift. |
| HTTP client in the Function | Built-in `fetch` | No new dependency; `verify.js` already does this. |

## 1. Function: `POST /email`

File: `functions/email.js`.

**Request body (JSON):**

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiKey` | string | yes | SendGrid API key with the Email Address Validation scope |
| `emails` | string[] or string | yes | A string is split on newlines and commas |
| `source` | string | no | Passed through to SendGrid. Letters, digits and spaces only; anything else is a 400 |
| `concurrency` | number | no | Clamped to 1–7, default 5 |

**Processing:**

1. Split, trim, and de-duplicate `emails` with a `Set`, same as `/lookup`. Empty list → HTTP 400 `{ error: "Provide at least one email address." }`.
2. Missing `apiKey` → HTTP 400 `{ error: "A SendGrid API key is required." }`.
3. Validate in fixed-size chunks with `Promise.all` (same `mapWithConcurrency` shape as `lookup.js`). Each address is one `POST https://api.sendgrid.com/v3/validations/email` with `Authorization: Bearer <apiKey>` and body `{ email, source? }`.
4. Each request has a 4-second `AbortSignal.timeout`. With concurrency 7 and a 30-address batch, that is at most 5 rounds; the timeout keeps a slow upstream from turning into a platform timeout.
5. HTTP 429 is retried at most twice, waiting 250 ms then 750 ms. Retries must fit inside the 10-second Function budget, so the count stays low.

**Per-address result** (one bad address never fails the batch):

```json
{ "input": "a@example.com", "ok": true,  "data": { "email": "…", "verdict": "Valid", "score": 0.97, "checks": { "…": "…" } } }
{ "input": "bad@",          "ok": false, "error": "…", "code": 400 }
```

`data` is SendGrid's `result` object, unmodified.

**Credential failure:** if any address comes back 401 or 403, the whole response is
HTTP 401 with `{ error: "SendGrid rejected the API key. It needs the Email Address Validation scope, which is available on Email API Pro and Premier plans only." }`.
The UI treats a non-2xx response as a hard error and stops the run, which is how a bad
OAuth secret already behaves on the Lookup tab. SendGrid's own error message, when
present, is appended.

**Response:** `{ results: [...] }`, HTTP 200.

`/email` does not fetch a Twilio access token. The OAuth gate is enforced by the UI
only; the SendGrid key is the credential that matters for this endpoint.

## 2. Shared batch module: `assets/batch.js`

Moved out of `app.js` and made endpoint-agnostic:

- `runInBatches({ items, endpoint, buildBody, batchSize, parallelBatches, signal, onProgress })` → `Promise<{ results, cancelled }>`. Replaces both `runLookupInChunks` and `runLookupSingle`: a list that fits in one batch is just a one-batch run. Results stay in input order; a cancel returns the in-order prefix that completed; a non-2xx response or network error aborts the other in-flight batches and rejects with the server's `error` message.
- `parseCsv`, `stripBom`, `extractColumnFromCsvRows` (renamed from `extractPhonesFromCsvRows`), `uniqueLines`.
- `flattenRecord`, `formatCell`, `resultsToRows`, `toCsv`, `downloadCsv`.
- `anyAbortSignal`, `mergeChunkResultsPrefix`.

Uses the same `if (typeof module !== "undefined" && module.exports)` export guard as
`breakdown.js`, so Node tests can `require` it. In the browser it loads as a plain
`<script>` before `app.js` and `email.js`.

`app.js` keeps auth, the Lookup form, and Lookup rendering, and calls `runInBatches`.
Lookup behaviour does not change: same defaults, same status text, same progress bar.

## 3. Frontend

**Tab bar.** A `role="tablist"` bar below the header with two `role="tab"` buttons,
**Lookup** and **Email**. Each controls a `role="tabpanel"`. The current `<main
class="layout">` becomes the Lookup panel without changes to its contents. Left/Right
arrow keys move between tabs. The active tab is kept in `sessionStorage` so a reload
returns to it. The page title in the header changes with the tab.

**Email panel** — same two-column `layout` as Lookup:

Input column:
- SendGrid API key: password input, plus a **Forget key** button. The key saves to `sessionStorage` on change. Hint: "Needs an API key with the Email Address Validation scope (Email API Pro or Premier)."
- Email addresses textarea, one per line or comma-separated.
- CSV upload: file, column (1 = first), addresses per batch (default 30), parallel batches (default 2), skip first N.
- `source` (optional) and concurrent validations per batch (1–7, default 5).
- Run, Cancel, Export CSV; progress bar, req/s, status line.
- Billing warning: "Each address is one billable validation."

Results column:
- Table with columns **Email | Verdict | Summary**. Verdict cell is coloured: Valid green, Risky amber, Invalid red, Error red.
- Summary: score to 2 decimals, then flags that are true — `disposable`, `role address`, `no MX/A record`, `bad syntax`, `known bounces`, `suspected bounces` — then `did you mean <suggestion>?` when SendGrid offers one.
- Click the email cell to expand the row's JSON, same as Lookup.
- Raw JSON preview and the 400-row preview cap, same as Lookup.

Export filename: `sendgrid-email-validation-<timestamp>.csv`.

**Sign out** clears `twilio_lookup_sendgrid` as well as the OAuth key.

File: `assets/email.js` holds Email-tab state and rendering only. All IDs in the Email
panel are prefixed `email` (e.g. `emailList`, `emailRun`) to avoid collisions with the
Lookup panel.

## 4. Error handling summary

| Situation | Behaviour |
|---|---|
| No key entered | UI blocks the run: "Enter a SendGrid API key first." |
| No addresses | UI blocks the run, same wording as Lookup |
| Key rejected (401/403) | `/email` returns 401; run stops; status shows the message from §1 |
| One address invalid or SendGrid 4xx for it | That row is `ok: false`; rest of the batch continues |
| 429 after retries | That row is `ok: false` with code 429 |
| Upstream timeout | That row is `ok: false`, error "SendGrid did not respond in time." |
| Network failure to `/email` | Run stops, partial results discarded, same as Lookup |

## 5. Testing

- `test/batch.test.js` — `runInBatches` with a stubbed global `fetch`: results come back in input order when batches finish out of order; a cancel returns the completed prefix with `cancelled: true`; a non-2xx response rejects with the server's error and stops other batches. Also unit cases for the moved helpers: `parseCsv` (quoted commas, quoted newlines, CRLF), `toCsv` (escaping, union of keys), `flattenRecord` (nested objects, arrays, nulls).
- `test/email-function.test.js` — loads `functions/email.js` with a stub `global.Twilio.Response` and stubbed `fetch`: dedupe; 400 for missing key, empty list, and bad `source`; a per-address error does not fail the batch; 401 from SendGrid becomes HTTP 401; a 429 then 200 succeeds after one retry.
- CI already runs `node --check` on every `functions/*.js` and `assets/*.js`, and `npm test`. No CI change.
- Manual: `npm run dev`, sign in, run the Lookup tab to confirm no regression, then the Email tab with a real key and a mix of valid, typo'd (`gmial.com`), and malformed addresses.

## 6. Docs

- README: feature line, a "SendGrid Email Validation" setup section (plan requirement, how to create the scoped key), and the billing warning.
- `docs/design.md`: the `/email` contract, `batch.js`, and the tab structure.

## Out of scope

- Verdict breakdown chart.
- SendGrid's bulk (CSV upload job) validation endpoint.
- Using the login without Twilio OAuth.
