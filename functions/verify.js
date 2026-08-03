/**
 * POST /verify — validates a Twilio OAuth app's Client ID + Client Secret.
 *
 * Validation is a token fetch rather than an API call: it proves the credentials
 * work without depending on which scopes the app was granted, and it is not
 * billable. See https://www.twilio.com/docs/iam/oauth-apps/account-oauth-apps
 */

const TOKEN_URL = "https://oauth.twilio.com/v2/token";

/** Leaves headroom inside the 10s Function timeout for a readable error. */
const TOKEN_TIMEOUT_MS = 8000;

/**
 * The access token is a JWT whose payload names the account it acts on. Used for
 * the account label in the UI only — the claim is undocumented, so a miss is normal.
 */
function accountSidFromToken(accessToken) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(accessToken).split(".")[1], "base64url").toString("utf8")
    );
    for (const value of Object.values(payload)) {
      if (typeof value === "string" && /^AC[0-9a-f]{32}$/i.test(value)) return value;
    }
  } catch {
    /* not a JWT, or a payload shape we don't recognise */
  }
  return undefined;
}

function describeTokenError(status, rawBody) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }
  const detail = parsed?.error_description || parsed?.message || parsed?.error;

  if (status === 400 || status === 401) {
    return detail
      ? `Invalid OAuth credentials — ${detail}`
      : "Invalid OAuth credentials. Check the Client ID and Client Secret, and that the secret has not been rotated.";
  }
  return detail || `Token request failed (HTTP ${status}).`;
}

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");

  const clientId = String(event.clientId || "").trim();
  const clientSecret = String(event.clientSecret || "").trim();

  if (!clientId || !clientSecret) {
    response.setStatusCode(400);
    response.setBody({
      valid: false,
      error: "OAuth Client ID and Client Secret are both required.",
    });
    return callback(null, response);
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    const text = await res.text();

    if (!res.ok) {
      response.setBody({ valid: false, error: describeTokenError(res.status, text) });
      return callback(null, response);
    }

    const token = JSON.parse(text);
    response.setBody({
      valid: true,
      accountSid: accountSidFromToken(token.access_token),
      expiresIn: token.expires_in,
    });
  } catch (err) {
    const msg =
      err.name === "TimeoutError" || err.name === "AbortError"
        ? "Twilio's token endpoint did not respond in time. Try again."
        : err.message || "Verification failed.";
    response.setBody({ valid: false, error: msg });
  }

  return callback(null, response);
};
