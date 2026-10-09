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
