# Design notes

How the deployed app is put together. This describes what ships, not a plan.

## Shape

A Twilio Serverless Service with three Functions and a static frontend served as Assets. There is no application server and no server-side state — the app holds no Twilio or SendGrid credentials of its own. Each user supplies their own at runtime.

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

## Functions

### `POST /verify`

Validates credentials before the lookup UI is shown.

Accepts `clientId` + `clientSecret` from an account-level [OAuth app](https://www.twilio.com/docs/iam/oauth-apps/account-oauth-apps). Rather than calling a Twilio API, it POSTs `grant_type=client_credentials` to `https://oauth.twilio.com/v2/token`: getting a token back proves the credentials work, costs nothing, and — unlike an API call — does not depend on which scopes the app happens to hold.

- Success → `{ valid: true, accountSid?: "ACxxx…", expiresIn: 3600 }`
- Bad credentials → `{ valid: false, error: "Invalid OAuth credentials — …" }` with HTTP 200
- Missing fields → `{ valid: false, error: … }` with HTTP 400

`accountSid` is best-effort: the access token is a JWT, and its payload is scanned for an `AC…`-shaped claim purely so the UI can show which account is in use. The claim is undocumented, so the frontend falls back to a truncated Client ID.

The token request carries an 8-second `AbortSignal.timeout` so a hung endpoint produces a readable error inside the 10s Function budget rather than a platform timeout.

### `POST /lookup`

Accepts a JSON body containing `clientId`, `clientSecret`, `numbers`, `fields`, and the optional Lookup parameters (`countryCode`, `lastVerifiedDate`, `partnerSubId`, `identityMatch`).

Authentication goes through the SDK's `ClientCredentialProviderBuilder`, attached with `client.setCredentialProvider(...)` — the constructor ignores a `credentialProvider` passed in its options, and `setCredentialProvider` also clears `accountSid`, which is why `/verify` cannot reuse an account fetch.

Two details make the OAuth path fit the timeout budget:

- **The strategy is memoised.** `BaseTwilio.request()` calls `credentialProvider.toAuthStrategy()` on *every* API request, and each call returns a strategy with an empty token cache — so a 30-number batch would fetch 30 access tokens. `createClient` pins one strategy in place; the strategy's own 30-second expiry buffer still triggers a refetch when a long batch outlives its token. Measured: 30 lookups drop from 30 token fetches to 1.
- **The token is fetched up front.** The handler awaits `authStrategy.getAuthString()` before fanning out, so bad credentials return a single HTTP 401 instead of the same error repeated once per number. Token failures arrive as a wrapped multi-line `Error` with no `code` or `status`, so they are matched on message text.

`numbers` may be an array or a newline/comma-delimited string; it is split, trimmed, and de-duplicated via a `Set`. An empty list is a 400.

Lookups run through `mapWithConcurrency`, which processes fixed-size chunks with `Promise.all`. Concurrency is clamped to **1–7**, default 5. That ceiling exists because Twilio Functions have a [10-second execution timeout](https://www.twilio.com/docs/serverless/functions-assets/functions/execution-limits) — the client compensates by sending many small batches in parallel rather than one large request. `assets/app.js` mirrors the same cap so the UI can't request more than the Function will honour.

Per-number failures are captured rather than thrown, so one bad number never fails the batch:

```json
{
  "results": [
    { "input": "+14155552671", "ok": true,  "data": { "…": "…" } },
    { "input": "+1555",        "ok": false, "error": "…", "code": 20404 }
  ],
  "fetchParams": { "fields": "line_type_intelligence" }
}
```

The Twilio SDK's built-in 429 backoff is enabled with `maxRetries: 3` — deliberately low, since retries also have to fit inside the 10-second budget.

### `POST /email`

Accepts JSON `{ apiKey, emails, source?, concurrency? }`. `apiKey` is the caller's SendGrid key with the Email Address Validation scope. No Twilio token is fetched: the OAuth gate is enforced by the UI, and the SendGrid key is the credential that matters here.

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

## Frontend

`index.html` holds both views; `initAuth()` picks one on load.

**Auth.** Credentials are verified by `/verify`, then written to `sessionStorage` under the single key `twilio_lookup_oauth` as a JSON blob (`clientId`, `clientSecret`, `accountSid`). On load, `initAuth()` shows the lookup view if both `clientId` and `clientSecret` are present — it does not re-verify, so a rotated secret surfaces as an error on the first lookup instead. A `/lookup` response with a non-2xx status aborts the whole run and shows the Function's error message, which is what an expired or revoked secret looks like mid-run. Sign-out clears the key and the form fields.

Every `/lookup` request carries credentials in its JSON body via `getCredsForRequest()`. Nothing is written to disk, and Twilio Serverless does not log request bodies.

**Tabs.** A `role="tablist"` under the header switches between the Lookup and Email panels; Left/Right arrows move between tabs. The active tab is kept in `sessionStorage` (`twilio_lookup_tab`) so a reload returns to it. Each tab has its own header text. The Email tab's SendGrid key is stored separately under `twilio_lookup_sendgrid`; sign-out clears it along with the OAuth key.

**Batching.** Both tabs run through `runInBatches` in `batch.js`. The list is chunked by batch size (Lookup: default 30, max 2000; Email: default 30, max 50) and sent as several requests, up to `parallelBatches` (default 2) in flight. A progress bar tracks completion, the run is cancellable via `AbortController`, and partial results stay exportable. Full results live in memory for CSV export; the on-screen table and JSON preview are truncated (`TABLE_PREVIEW_LIMIT`, `RAW_JSON_PREVIEW_ROWS`) to keep rendering cheap on large runs.

## Security properties

- Credentials travel over HTTPS only — Twilio Functions do not serve plaintext HTTP.
- A fresh Twilio client is constructed per request, so nothing leaks between callers.
- No credentials are stored server-side, in environment variables, or in logs.
- Credential-shaped fields are validated before any Twilio call is attempted.

Two properties worth stating plainly, because they are consequences of the design rather than oversights:

- **`sessionStorage` is readable by JavaScript on the page.** Any XSS on the deployed origin can exfiltrate whatever is stored there. OAuth does not remove that exposure — the Client Secret sits where the Auth Token used to. What it changes is blast radius: the app can be scoped to Lookup alone, and its secret rotated with a grace period, independently of the account's master credential. Access tokens are never stored at all.
- **The Function URLs are public.** Anyone with the URL can use the tool, but only with OAuth credentials or a SendGrid key they already hold. The deployment holds no credentials of its own, so it cannot be used to spend the owner's balance or validation credits.

## Constraints and trade-offs

| Constraint | Consequence |
|---|---|
| 10s Function timeout (30s on paid) | Caps concurrency at 7 and pushes batching to the client |
| No server-side session | Credentials must accompany every request |
| Per-service concurrency limits | Several heavy users on one deployment can throttle each other; fine for team use |
| 10MB Asset limit | `app.js` is larger than ideal but far under the ceiling |

## Runtime

Pinned to `node24` in `.twilioserverlessrc`. Without that key the Serverless API silently reuses the runtime of the last successful build, which makes deploys from a fresh clone non-reproducible.

`@twilio/runtime-handler` is deliberately **not** declared in `package.json`. The platform injects it and auto-upgrades it at build time; the version node24 requires (≥2.1.2) is not published on npm, so pinning it here would be impossible to satisfy.
