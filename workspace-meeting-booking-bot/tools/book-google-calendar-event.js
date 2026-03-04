#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  prepareBookingPayload,
} = require("./prepare-booking-payload.js");

const GOOGLE_CALENDAR_API_BASE_URL = "https://www.googleapis.com/calendar/v3";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const BOOKING_SUCCESS_PREFIX = "Booked ✅";
const MISSING_REFRESH_TOKEN_ERROR = "GOOGLE_AUTH_REFRESH_TOKEN_MISSING";
const MISSING_CLIENT_SECRET_ERROR = "GOOGLE_CLIENT_SECRET_MISSING";
const INVALID_CLIENT_SECRET_ERROR = "GOOGLE_CLIENT_SECRET_INVALID";
const MISSING_AUTH_CODE_ERROR = "GOOGLE_AUTH_CODE_MISSING";
const MISSING_REDIRECT_URI_ERROR = "GOOGLE_REDIRECT_URI_MISSING";
const AUTH_CODE_EXCHANGE_FAILED_ERROR = "GOOGLE_AUTH_CODE_EXCHANGE_FAILED";
const ACCESS_TOKEN_REFRESH_FAILED_ERROR = "GOOGLE_ACCESS_TOKEN_REFRESH_FAILED";
const INVALID_OAUTH_TOKEN_RESPONSE_ERROR = "GOOGLE_OAUTH_TOKEN_INVALID_RESPONSE";
const INSERT_FAILED_ERROR = "GOOGLE_CALENDAR_INSERT_FAILED";
const INVALID_INSERT_RESPONSE_ERROR = "GOOGLE_CALENDAR_INVALID_INSERT_RESPONSE";
const MEET_CONFERENCE_SOLUTION_TYPE = "hangoutsMeet";

class BookingToolError extends Error {
  constructor({ code, message, status, cause }) {
    super(message);
    this.name = "BookingToolError";
    this.code = code;
    if (status !== undefined) {
      this.status = status;
    }
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function ensureObject(value, fieldName) {
  if (value == null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BookingToolError({
      code: "INVALID_INPUT",
      message: `${fieldName} must be an object`,
    });
  }
  return value;
}

function ensureNonEmptyString(value, fieldName) {
  if (typeof value !== "string") {
    throw new BookingToolError({
      code: "INVALID_INPUT",
      message: `${fieldName} must be a string`,
    });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new BookingToolError({
      code: "INVALID_INPUT",
      message: `${fieldName} must be a non-empty string`,
    });
  }
  return trimmed;
}

function normalizeSecretRefString(value, fieldName) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.value === "string" && value.value.trim()) {
      return value.value.trim();
    }
  }
  throw new BookingToolError({
    code: "INVALID_INPUT",
    message: `${fieldName} must resolve to a non-empty string`,
  });
}

function resolveRefreshToken(credentials = {}) {
  const creds = ensureObject(credentials, "credentials");

  if (creds.refreshToken != null) {
    try {
      return normalizeSecretRefString(
        creds.refreshToken,
        "credentials.refreshToken",
      );
    } catch (_error) {
      throw new BookingToolError({
        code: MISSING_REFRESH_TOKEN_ERROR,
        message:
          "Google OAuth refresh token is missing. Provide credentials.refreshToken via SecretRef resolution.",
      });
    }
  }

  throw new BookingToolError({
    code: MISSING_REFRESH_TOKEN_ERROR,
    message:
      "Google OAuth refresh token is missing. Provide credentials.refreshToken via SecretRef resolution.",
  });
}

function parseClientSecretJson(credentials = {}) {
  const creds = ensureObject(credentials, "credentials");

  if (!hasOwn(creds, "clientSecret") || creds.clientSecret == null) {
    throw new BookingToolError({
      code: MISSING_CLIENT_SECRET_ERROR,
      message:
        "Google OAuth client_secret.json is missing. Provide credentials.clientSecret via SecretRef resolution.",
    });
  }

  const rawClientSecret = creds.clientSecret;
  let parsed;

  if (typeof rawClientSecret === "string") {
    try {
      parsed = JSON.parse(rawClientSecret);
    } catch (error) {
      throw new BookingToolError({
        code: INVALID_CLIENT_SECRET_ERROR,
        message: "credentials.clientSecret must contain valid client_secret.json content.",
        cause: error,
      });
    }
  } else if (
    rawClientSecret &&
    typeof rawClientSecret === "object" &&
    !Array.isArray(rawClientSecret)
  ) {
    if (typeof rawClientSecret.value === "string") {
      try {
        parsed = JSON.parse(rawClientSecret.value);
      } catch (error) {
        throw new BookingToolError({
          code: INVALID_CLIENT_SECRET_ERROR,
          message:
            "credentials.clientSecret.value must contain valid client_secret.json content.",
          cause: error,
        });
      }
    } else if (
      rawClientSecret.value &&
      typeof rawClientSecret.value === "object" &&
      !Array.isArray(rawClientSecret.value)
    ) {
      parsed = rawClientSecret.value;
    } else {
      parsed = rawClientSecret;
    }
  } else {
    throw new BookingToolError({
      code: INVALID_CLIENT_SECRET_ERROR,
      message:
        "credentials.clientSecret must resolve to client_secret.json text or object.",
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BookingToolError({
      code: INVALID_CLIENT_SECRET_ERROR,
      message: "Parsed client_secret.json content must be an object.",
    });
  }

  return parsed;
}

function resolveOAuthClientCredentials(credentials = {}) {
  const secretDoc = parseClientSecretJson(credentials);
  const clientSection =
    secretDoc.installed ||
    secretDoc.web ||
    secretDoc;

  if (
    !clientSection ||
    typeof clientSection !== "object" ||
    Array.isArray(clientSection)
  ) {
    throw new BookingToolError({
      code: INVALID_CLIENT_SECRET_ERROR,
      message: "client_secret.json does not contain an OAuth client section.",
    });
  }

  const clientId = ensureNonEmptyString(
    clientSection.client_id || clientSection.clientId,
    "client_secret.client_id",
  );
  const clientSecret = ensureNonEmptyString(
    clientSection.client_secret || clientSection.clientSecret,
    "client_secret.client_secret",
  );
  const tokenUri =
    typeof clientSection.token_uri === "string" && clientSection.token_uri.trim()
      ? clientSection.token_uri.trim()
      : GOOGLE_OAUTH_TOKEN_URL;

  const redirectUrisRaw = clientSection.redirect_uris || clientSection.redirectUris;
  const redirectUris = Array.isArray(redirectUrisRaw)
    ? redirectUrisRaw
        .filter((entry) => typeof entry === "string" && entry.trim())
        .map((entry) => entry.trim())
    : [];

  return {
    clientId,
    clientSecret,
    tokenUri,
    redirectUris,
  };
}

function buildOauthTokenRequest({
  oauthClient,
  params,
}) {
  const client = ensureObject(oauthClient, "oauthClient");
  const requestParams = ensureObject(params, "params");

  const tokenUri = ensureNonEmptyString(
    client.tokenUri || GOOGLE_OAUTH_TOKEN_URL,
    "oauthClient.tokenUri",
  );
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(requestParams)) {
    body.set(key, ensureNonEmptyString(value, `params.${key}`));
  }

  return {
    url: tokenUri,
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
  };
}

function buildAuthCodeExchangeRequest({
  oauthClient,
  authCode,
  redirectUri,
}) {
  const client = ensureObject(oauthClient, "oauthClient");
  if (typeof authCode !== "string" || !authCode.trim()) {
    throw new BookingToolError({
      code: MISSING_AUTH_CODE_ERROR,
      message: "Google OAuth auth code is required.",
    });
  }
  const code = authCode.trim();

  const resolvedRedirectUri =
    redirectUri == null
      ? client.redirectUris && client.redirectUris.length > 0
        ? client.redirectUris[0]
        : null
      : redirectUri;

  if (resolvedRedirectUri == null) {
    throw new BookingToolError({
      code: MISSING_REDIRECT_URI_ERROR,
      message:
        "Google OAuth redirect URI is required for auth code exchange. Pass redirectUri or include redirect_uris in client_secret.json.",
    });
  }

  return buildOauthTokenRequest({
    oauthClient: client,
    params: {
      code,
      client_id: ensureNonEmptyString(client.clientId, "oauthClient.clientId"),
      client_secret: ensureNonEmptyString(
        client.clientSecret,
        "oauthClient.clientSecret",
      ),
      redirect_uri: ensureNonEmptyString(resolvedRedirectUri, "redirectUri"),
      grant_type: "authorization_code",
    },
  });
}

function buildRefreshAccessTokenRequest({
  oauthClient,
  refreshToken,
}) {
  const client = ensureObject(oauthClient, "oauthClient");
  const token = ensureNonEmptyString(refreshToken, "refreshToken");

  return buildOauthTokenRequest({
    oauthClient: client,
    params: {
      refresh_token: token,
      client_id: ensureNonEmptyString(client.clientId, "oauthClient.clientId"),
      client_secret: ensureNonEmptyString(
        client.clientSecret,
        "oauthClient.clientSecret",
      ),
      grant_type: "refresh_token",
    },
  });
}

function trimmedStringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function generateConferenceRequestId() {
  if (typeof crypto.randomUUID === "function") {
    return `meeting-booking-bot-${crypto.randomUUID()}`;
  }
  return `meeting-booking-bot-${Date.now()}`;
}

function buildMeetConferenceData(existingConferenceData, conferenceRequestId) {
  const conferenceData = ensureObject(
    existingConferenceData,
    "event.conferenceData",
  );
  const existingCreateRequest = ensureObject(
    conferenceData.createRequest,
    "event.conferenceData.createRequest",
  );
  const existingConferenceSolutionKey = ensureObject(
    existingCreateRequest.conferenceSolutionKey,
    "event.conferenceData.createRequest.conferenceSolutionKey",
  );

  return {
    ...conferenceData,
    createRequest: {
      ...existingCreateRequest,
      conferenceSolutionKey: {
        ...existingConferenceSolutionKey,
        type: MEET_CONFERENCE_SOLUTION_TYPE,
      },
      requestId:
        trimmedStringOrNull(conferenceRequestId) || generateConferenceRequestId(),
    },
  };
}

function extractConferenceVideoLink(conferenceData) {
  if (!conferenceData || typeof conferenceData !== "object" || Array.isArray(conferenceData)) {
    return null;
  }

  const { entryPoints } = conferenceData;
  if (!Array.isArray(entryPoints)) {
    return null;
  }

  for (const entryPoint of entryPoints) {
    if (!entryPoint || typeof entryPoint !== "object" || Array.isArray(entryPoint)) {
      continue;
    }
    const entryPointType = trimmedStringOrNull(entryPoint.entryPointType);
    const uri = trimmedStringOrNull(entryPoint.uri);
    if (entryPointType === "video" && uri) {
      return uri;
    }
  }

  return null;
}

function resolvePreferredBookingLink(responseBody) {
  if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody)) {
    return null;
  }

  return (
    trimmedStringOrNull(responseBody.hangoutLink) ||
    extractConferenceVideoLink(responseBody.conferenceData) ||
    trimmedStringOrNull(responseBody.htmlLink)
  );
}

function buildInsertRequest({
  calendarId,
  accessToken,
  event,
  conferenceRequestId,
  baseUrl = GOOGLE_CALENDAR_API_BASE_URL,
}) {
  const safeCalendarId = ensureNonEmptyString(calendarId, "calendarId");
  const safeAccessToken = ensureNonEmptyString(accessToken, "accessToken");
  const safeEvent = ensureObject(event, "event");
  const safeBaseUrl = ensureNonEmptyString(baseUrl, "baseUrl");
  const eventWithConferenceData = {
    ...safeEvent,
    conferenceData: buildMeetConferenceData(
      safeEvent.conferenceData,
      conferenceRequestId,
    ),
  };

  const url = new URL(
    `${safeBaseUrl}/calendars/${encodeURIComponent(safeCalendarId)}/events`,
  );
  url.searchParams.set("sendUpdates", "all");
  url.searchParams.set("conferenceDataVersion", "1");
  return {
    url: url.toString(),
    options: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${safeAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(eventWithConferenceData),
    },
  };
}

function formatBookingSuccess(link) {
  const safeLink = ensureNonEmptyString(link, "event.link");
  return `${BOOKING_SUCCESS_PREFIX} ${safeLink}`;
}

async function safeReadJson(response) {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

async function executeOauthTokenRequest({
  request,
  fetchImpl,
  errorCode,
  errorMessagePrefix,
}) {
  let response;
  try {
    response = await fetchImpl(request.url, request.options);
  } catch (error) {
    throw new BookingToolError({
      code: errorCode,
      message: `${errorMessagePrefix} before reaching Google OAuth endpoint.`,
      cause: error,
    });
  }

  const responseBody = await safeReadJson(response);
  if (!response.ok) {
    const apiMessage =
      responseBody &&
      responseBody.error_description &&
      typeof responseBody.error_description === "string" &&
      responseBody.error_description.trim()
        ? responseBody.error_description.trim()
        : responseBody &&
            responseBody.error &&
            typeof responseBody.error === "string" &&
            responseBody.error.trim()
          ? responseBody.error.trim()
          : `HTTP ${response.status}`;
    throw new BookingToolError({
      code: errorCode,
      status: response.status,
      message: `${errorMessagePrefix}: ${apiMessage}`,
    });
  }

  if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody)) {
    throw new BookingToolError({
      code: INVALID_OAUTH_TOKEN_RESPONSE_ERROR,
      status: response.status,
      message: "Google OAuth token endpoint returned non-object JSON.",
    });
  }

  return responseBody;
}

async function exchangeGoogleAuthCodeForRefreshToken(input = {}) {
  const params = ensureObject(input, "input");
  const fetchImpl =
    typeof params.fetchImpl === "function"
      ? params.fetchImpl
      : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new BookingToolError({
      code: "FETCH_UNAVAILABLE",
      message: "Fetch implementation is required for Google OAuth calls.",
    });
  }

  const oauthClient = resolveOAuthClientCredentials(params.credentials);
  const request = buildAuthCodeExchangeRequest({
    oauthClient,
    authCode: params.authCode,
    redirectUri: params.redirectUri,
  });

  const responseBody = await executeOauthTokenRequest({
    request,
    fetchImpl,
    errorCode: AUTH_CODE_EXCHANGE_FAILED_ERROR,
    errorMessagePrefix: "Google OAuth auth-code exchange failed",
  });

  if (
    typeof responseBody.refresh_token !== "string" ||
    !responseBody.refresh_token.trim()
  ) {
    throw new BookingToolError({
      code: INVALID_OAUTH_TOKEN_RESPONSE_ERROR,
      message:
        "Google OAuth auth-code exchange succeeded but refresh_token is missing. Ensure consent was requested with access_type=offline and prompt=consent.",
    });
  }

  return {
    refreshToken: responseBody.refresh_token.trim(),
    accessToken:
      typeof responseBody.access_token === "string" && responseBody.access_token.trim()
        ? responseBody.access_token.trim()
        : undefined,
    scope:
      typeof responseBody.scope === "string" && responseBody.scope.trim()
        ? responseBody.scope.trim()
        : undefined,
    tokenType:
      typeof responseBody.token_type === "string" && responseBody.token_type.trim()
        ? responseBody.token_type.trim()
        : undefined,
  };
}

async function refreshGoogleAccessToken(input = {}) {
  const params = ensureObject(input, "input");
  const fetchImpl =
    typeof params.fetchImpl === "function"
      ? params.fetchImpl
      : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new BookingToolError({
      code: "FETCH_UNAVAILABLE",
      message: "Fetch implementation is required for Google OAuth calls.",
    });
  }

  const oauthClient = resolveOAuthClientCredentials(params.credentials);
  const refreshToken = resolveRefreshToken(params.credentials);
  const request = buildRefreshAccessTokenRequest({
    oauthClient,
    refreshToken,
  });

  const responseBody = await executeOauthTokenRequest({
    request,
    fetchImpl,
    errorCode: ACCESS_TOKEN_REFRESH_FAILED_ERROR,
    errorMessagePrefix: "Google OAuth access-token refresh failed",
  });

  if (
    typeof responseBody.access_token !== "string" ||
    !responseBody.access_token.trim()
  ) {
    throw new BookingToolError({
      code: INVALID_OAUTH_TOKEN_RESPONSE_ERROR,
      message:
        "Google OAuth access-token refresh succeeded but access_token is missing.",
    });
  }

  return responseBody.access_token.trim();
}

async function writeSecretRefValueFile(input = {}) {
  const params = ensureObject(input, "input");
  const targetPath = ensureNonEmptyString(params.filePath, "input.filePath");
  const value = ensureNonEmptyString(params.value, "input.value");
  const fsImpl = params.fsImpl || fs;

  await fsImpl.mkdir(path.dirname(targetPath), { recursive: true });
  await fsImpl.writeFile(
    targetPath,
    `${JSON.stringify({ value }, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (typeof fsImpl.chmod === "function") {
    await fsImpl.chmod(targetPath, 0o600);
  }
}

function toUserFacingBookingError(error) {
  if (error && error.code === MISSING_REFRESH_TOKEN_ERROR) {
    return "Booking failed: missing Google OAuth refresh token.";
  }
  if (
    error &&
    (error.code === MISSING_CLIENT_SECRET_ERROR ||
      error.code === INVALID_CLIENT_SECRET_ERROR)
  ) {
    return "Booking failed: missing Google OAuth client credentials.";
  }
  if (
    error &&
    (error.code === ACCESS_TOKEN_REFRESH_FAILED_ERROR ||
      error.code === INVALID_OAUTH_TOKEN_RESPONSE_ERROR)
  ) {
    return "Booking failed: could not refresh Google OAuth access token.";
  }
  if (error && error.code === INSERT_FAILED_ERROR) {
    return "Booking failed: Google Calendar rejected the insert request.";
  }
  if (error && error.code === INVALID_INSERT_RESPONSE_ERROR) {
    return "Booking failed: Google Calendar returned event without a usable booking link.";
  }
  return "Booking failed: unexpected error.";
}

async function insertGoogleCalendarEvent(input = {}) {
  const params = ensureObject(input, "input");
  const config = ensureObject(params.config, "input.config");
  const booking = ensureObject(params.booking, "input.booking");
  const credentials = ensureObject(params.credentials, "input.credentials");
  const fetchImpl =
    typeof params.fetchImpl === "function"
      ? params.fetchImpl
      : globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new BookingToolError({
      code: "FETCH_UNAVAILABLE",
      message: "Fetch implementation is required for Google Calendar API calls.",
    });
  }

  const payload = prepareBookingPayload({ config, booking });
  const accessToken = await refreshGoogleAccessToken({
    credentials,
    fetchImpl,
  });
  const request = buildInsertRequest({
    calendarId: payload.calendarId,
    accessToken,
    event: payload.event,
    baseUrl: params.baseUrl,
  });

  let response;
  try {
    response = await fetchImpl(request.url, request.options);
  } catch (error) {
    throw new BookingToolError({
      code: INSERT_FAILED_ERROR,
      message: "Google Calendar events.insert request failed before reaching API.",
      cause: error,
    });
  }

  const responseBody = await safeReadJson(response);

  if (!response.ok) {
    const apiMessage =
      responseBody &&
      responseBody.error &&
      typeof responseBody.error.message === "string" &&
      responseBody.error.message.trim()
        ? responseBody.error.message.trim()
        : `HTTP ${response.status}`;
    throw new BookingToolError({
      code: INSERT_FAILED_ERROR,
      status: response.status,
      message: `Google Calendar events.insert failed: ${apiMessage}`,
    });
  }

  const bookingLink = resolvePreferredBookingLink(responseBody);
  if (!bookingLink) {
    throw new BookingToolError({
      code: INVALID_INSERT_RESPONSE_ERROR,
      message:
        "Google Calendar events.insert succeeded but response is missing Meet and event links.",
    });
  }

  return {
    message: formatBookingSuccess(bookingLink),
  };
}

module.exports = {
  ACCESS_TOKEN_REFRESH_FAILED_ERROR,
  AUTH_CODE_EXCHANGE_FAILED_ERROR,
  BOOKING_SUCCESS_PREFIX,
  BookingToolError,
  GOOGLE_CALENDAR_API_BASE_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  INSERT_FAILED_ERROR,
  INVALID_CLIENT_SECRET_ERROR,
  INVALID_INSERT_RESPONSE_ERROR,
  INVALID_OAUTH_TOKEN_RESPONSE_ERROR,
  MISSING_AUTH_CODE_ERROR,
  MISSING_CLIENT_SECRET_ERROR,
  MISSING_REDIRECT_URI_ERROR,
  MISSING_REFRESH_TOKEN_ERROR,
  buildAuthCodeExchangeRequest,
  buildRefreshAccessTokenRequest,
  buildInsertRequest,
  exchangeGoogleAuthCodeForRefreshToken,
  extractConferenceVideoLink,
  formatBookingSuccess,
  buildMeetConferenceData,
  insertGoogleCalendarEvent,
  refreshGoogleAccessToken,
  resolvePreferredBookingLink,
  resolveOAuthClientCredentials,
  resolveRefreshToken,
  toUserFacingBookingError,
  writeSecretRefValueFile,
};
