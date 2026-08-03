const twilio = require("twilio");
const { ClientCredentialProviderBuilder } = twilio;

/**
 * Builds a client authenticated with a Twilio OAuth app (Client Credentials).
 * Returns the auth strategy too, so the caller can fetch the access token once
 * before fanning out. See https://www.twilio.com/docs/iam/oauth-apps/overview
 */
function createClient(event) {
  const clientId = String(event.clientId || "").trim();
  const clientSecret = String(event.clientSecret || "").trim();
  if (!clientId || !clientSecret) {
    throw new Error("OAuth Client ID and Client Secret are both required.");
  }

  const provider = new ClientCredentialProviderBuilder()
    .setClientId(clientId)
    .setClientSecret(clientSecret)
    .build();

  // The SDK calls toAuthStrategy() once per API request, and every call returns a
  // strategy with an empty token cache — so a 30-number batch would fetch 30
  // access tokens. Memoising it makes that one fetch per invocation; the strategy
  // still re-fetches on its own once the token is within 30s of expiring.
  const authStrategy = provider.toAuthStrategy();
  provider.toAuthStrategy = () => authStrategy;

  // Credentials come from the provider, so the constructor gets no SID/secret.
  const client = new twilio.Twilio(undefined, undefined, {
    autoRetry: true,
    maxRetries: 3,
  });
  client.setCredentialProvider(provider);

  return { client, authStrategy };
}

/** Token failures surface as a wrapped, multi-line Error with no code or status. */
function tokenErrorMessage(err) {
  const raw = (err.message || String(err)).replace(/\s+/g, " ").trim();
  if (/\b401\b|invalid credentials|invalid_client/i.test(raw)) {
    return "Invalid OAuth credentials. Check the Client ID and Client Secret, then sign in again.";
  }
  return `Could not obtain a Twilio access token — ${raw}`;
}

function buildFetchParams(event) {
  const fields = Array.isArray(event.fields)
    ? event.fields.filter(Boolean)
    : [];
  const params = {};

  if (fields.length) params.fields = fields.join(",");
  if (event.countryCode) params.countryCode = String(event.countryCode).trim();
  if (event.lastVerifiedDate)
    params.lastVerifiedDate = String(event.lastVerifiedDate).trim();
  if (event.partnerSubId)
    params.partnerSubId = String(event.partnerSubId).trim();

  const im = event.identityMatch || {};
  const imKeys = [
    "firstName",
    "lastName",
    "addressLine1",
    "addressLine2",
    "city",
    "state",
    "postalCode",
    "addressCountryCode",
    "nationalId",
    "dateOfBirth",
  ];
  for (const key of imKeys) {
    if (im[key] != null && String(im[key]).trim() !== "") {
      params[key] = String(im[key]).trim();
    }
  }

  return params;
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
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");

  const raw = event.numbers;
  const lines = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\r\n,]+/)
      : [];
  const numbers = [
    ...new Set(lines.map((n) => String(n).trim()).filter((n) => n.length > 0)),
  ];

  if (!numbers.length) {
    response.setStatusCode(400);
    response.setBody({ error: "Provide at least one phone number." });
    return callback(null, response);
  }

  let client;
  let authStrategy;
  try {
    ({ client, authStrategy } = createClient(event));
  } catch (e) {
    response.setStatusCode(400);
    response.setBody({ error: e.message });
    return callback(null, response);
  }

  // Get the access token before fanning out. Bad credentials then cost one clear
  // 401 instead of the same error repeated once per number.
  try {
    await authStrategy.getAuthString();
  } catch (e) {
    response.setStatusCode(401);
    response.setBody({ error: tokenErrorMessage(e) });
    return callback(null, response);
  }

  const fetchParams = buildFetchParams(event);
  const concurrency = Math.min(Math.max(Number(event.concurrency) || 5, 1), 7);

  const results = await mapWithConcurrency(
    numbers,
    concurrency,
    async (phone) => {
      try {
        const resource = await client.lookups.v2
          .phoneNumbers(phone)
          .fetch(fetchParams);
        const data = JSON.parse(JSON.stringify(resource.toJSON()));
        return { input: phone, ok: true, data };
      } catch (err) {
        const code = err.code ?? err.status;
        const message = err.message || String(err);
        return { input: phone, ok: false, error: message, code };
      }
    }
  );

  response.setBody({ results, fetchParams });
  return callback(null, response);
};
