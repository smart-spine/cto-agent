const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  CALENDAR_SELECTION_RULE,
  DEFAULT_CALENDAR_ID,
  DEFAULT_TIMEZONE,
  prepareBookingPayload,
  resolveCalendarTarget,
} = require("../tools/prepare-booking-payload.js");
const {
  BOOKING_SUCCESS_PREFIX,
  GOOGLE_CALENDAR_API_BASE_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  MISSING_REFRESH_TOKEN_ERROR,
  ACCESS_TOKEN_REFRESH_FAILED_ERROR,
  buildAuthCodeExchangeRequest,
  buildRefreshAccessTokenRequest,
  buildInsertRequest,
  formatBookingSuccess,
  insertGoogleCalendarEvent,
  refreshGoogleAccessToken,
  exchangeGoogleAuthCodeForRefreshToken,
  toUserFacingBookingError,
  writeSecretRefValueFile,
} = require("../tools/book-google-calendar-event.js");
const { createCalendarEvent } = require("../tools/create-calendar-event.js");

const CLIENT_SECRET_JSON = JSON.stringify({
  installed: {
    client_id: "client-id.apps.googleusercontent.com",
    client_secret: "client-secret",
    token_uri: GOOGLE_OAUTH_TOKEN_URL,
    redirect_uris: ["http://localhost:8080/oauth2callback"],
  },
});

test("resolveCalendarTarget uses configured calendarId strictly", () => {
  assert.equal(
    resolveCalendarTarget({ calendarId: "team-calendar@example.com" }),
    "team-calendar@example.com",
  );
});

test("resolveCalendarTarget falls back to primary when calendarId is absent", () => {
  assert.equal(resolveCalendarTarget({ timezone: "Europe/Warsaw" }), DEFAULT_CALENDAR_ID);
  assert.equal(resolveCalendarTarget({}), DEFAULT_CALENDAR_ID);
});

test("resolveCalendarTarget errors when calendarId is set but empty", () => {
  assert.throws(
    () => resolveCalendarTarget({ calendarId: "   " }),
    /config\.calendarId must be a non-empty string/,
  );
});

test("prepareBookingPayload builds deterministic payload with defaults", () => {
  const payload = prepareBookingPayload({
    config: {},
    booking: {
      summary: "Project Sync",
      description: "Weekly planning sync",
      location: "Warsaw HQ",
      start: "2026-03-10T09:00:00+01:00",
      end: "2026-03-10T09:30:00+01:00",
      attendees: ["a@example.com", { email: "b@example.com" }],
    },
  });

  assert.equal(payload.backend, "google-calendar");
  assert.equal(payload.calendarId, DEFAULT_CALENDAR_ID);
  assert.equal(payload.timezone, DEFAULT_TIMEZONE);
  assert.equal(payload.selectionRule, CALENDAR_SELECTION_RULE);
  assert.deepEqual(payload.event, {
    summary: "Project Sync",
    description: "Weekly planning sync",
    location: "Warsaw HQ",
    start: {
      dateTime: "2026-03-10T09:00:00+01:00",
      timeZone: "Europe/Warsaw",
    },
    end: {
      dateTime: "2026-03-10T09:30:00+01:00",
      timeZone: "Europe/Warsaw",
    },
    attendees: [{ email: "a@example.com" }, { email: "b@example.com" }],
  });
});

test("prepareBookingPayload honors config.calendarId and explicit booking timezone", () => {
  const payload = prepareBookingPayload({
    config: {
      calendarId: "strict-calendar-id",
      timezone: "Europe/Warsaw",
    },
    booking: {
      summary: "Client Call",
      start: "2026-03-10T10:00:00+01:00",
      end: "2026-03-10T11:00:00+01:00",
      timezone: "UTC",
    },
  });

  assert.equal(payload.calendarId, "strict-calendar-id");
  assert.equal(payload.timezone, "UTC");
  assert.equal(payload.event.start.timeZone, "UTC");
  assert.equal(payload.event.end.timeZone, "UTC");
  assert.deepEqual(payload.event.attendees, []);
});

test("prepareBookingPayload validates booking end is after booking start", () => {
  assert.throws(
    () =>
      prepareBookingPayload({
        booking: {
          summary: "Invalid",
          start: "2026-03-10T11:00:00+01:00",
          end: "2026-03-10T10:00:00+01:00",
        },
      }),
    /booking\.end must be after booking\.start/,
  );
});

test("formatBookingSuccess returns concise booking confirmation", () => {
  assert.equal(
    formatBookingSuccess("https://calendar.google.com/event?eid=abc123"),
    "Booked ✅ https://calendar.google.com/event?eid=abc123",
  );
  assert.equal(BOOKING_SUCCESS_PREFIX, "Booked ✅");
});

test("buildInsertRequest creates deterministic Google Calendar events.insert request with native invite emails", () => {
  const request = buildInsertRequest({
    calendarId: "team-calendar@example.com",
    accessToken: "oauth-token",
    conferenceRequestId: "conference-request-1",
    event: {
      summary: "Project Sync",
      start: { dateTime: "2026-03-10T09:00:00+01:00", timeZone: "Europe/Warsaw" },
      end: { dateTime: "2026-03-10T09:30:00+01:00", timeZone: "Europe/Warsaw" },
      attendees: [{ email: "a@example.com" }, { email: "b@example.com" }],
    },
  });

  const requestUrl = new URL(request.url);
  assert.equal(
    `${requestUrl.origin}${requestUrl.pathname}`,
    `${GOOGLE_CALENDAR_API_BASE_URL}/calendars/team-calendar%40example.com/events`,
  );
  assert.equal(requestUrl.searchParams.get("sendUpdates"), "all");
  assert.equal(requestUrl.searchParams.get("conferenceDataVersion"), "1");
  assert.equal(request.options.method, "POST");
  assert.equal(
    request.options.headers.Authorization,
    "Bearer oauth-token",
  );
  assert.equal(request.options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(request.options.body), {
    summary: "Project Sync",
    start: { dateTime: "2026-03-10T09:00:00+01:00", timeZone: "Europe/Warsaw" },
    end: { dateTime: "2026-03-10T09:30:00+01:00", timeZone: "Europe/Warsaw" },
    attendees: [{ email: "a@example.com" }, { email: "b@example.com" }],
    conferenceData: {
      createRequest: {
        conferenceSolutionKey: { type: "hangoutsMeet" },
        requestId: "conference-request-1",
      },
    },
  });
});

test("buildAuthCodeExchangeRequest creates OAuth authorization_code request", () => {
  const request = buildAuthCodeExchangeRequest({
    oauthClient: {
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "client-secret",
      tokenUri: GOOGLE_OAUTH_TOKEN_URL,
      redirectUris: ["http://localhost:8080/oauth2callback"],
    },
    authCode: "4/0AbCdEf",
  });

  assert.equal(request.url, GOOGLE_OAUTH_TOKEN_URL);
  assert.equal(request.options.method, "POST");
  assert.equal(
    request.options.headers["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  const body = new URLSearchParams(request.options.body);
  assert.equal(body.get("code"), "4/0AbCdEf");
  assert.equal(body.get("client_id"), "client-id.apps.googleusercontent.com");
  assert.equal(body.get("client_secret"), "client-secret");
  assert.equal(body.get("redirect_uri"), "http://localhost:8080/oauth2callback");
  assert.equal(body.get("grant_type"), "authorization_code");
});

test("exchangeGoogleAuthCodeForRefreshToken exchanges auth code and returns refresh token", async () => {
  const calls = [];
  const result = await exchangeGoogleAuthCodeForRefreshToken({
    authCode: "4/0AbCdEf",
    credentials: {
      clientSecret: { value: CLIENT_SECRET_JSON },
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: "initial-access",
            refresh_token: "refresh-from-auth-code",
            scope: "https://www.googleapis.com/auth/calendar.events",
            token_type: "Bearer",
          };
        },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GOOGLE_OAUTH_TOKEN_URL);
  const body = new URLSearchParams(calls[0].options.body);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "4/0AbCdEf");
  assert.equal(result.refreshToken, "refresh-from-auth-code");
  assert.equal(result.accessToken, "initial-access");
});

test("buildRefreshAccessTokenRequest creates OAuth refresh_token request", () => {
  const request = buildRefreshAccessTokenRequest({
    oauthClient: {
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "client-secret",
      tokenUri: GOOGLE_OAUTH_TOKEN_URL,
    },
    refreshToken: "refresh-token-123",
  });

  assert.equal(request.url, GOOGLE_OAUTH_TOKEN_URL);
  const body = new URLSearchParams(request.options.body);
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "refresh-token-123");
  assert.equal(body.get("client_id"), "client-id.apps.googleusercontent.com");
  assert.equal(body.get("client_secret"), "client-secret");
});

test("refreshGoogleAccessToken uses refresh token + client secret and returns access token", async () => {
  const calls = [];
  const accessToken = await refreshGoogleAccessToken({
    credentials: {
      refreshToken: { value: "refresh-token-abc" },
      clientSecret: { value: CLIENT_SECRET_JSON },
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: "refreshed-access-token",
            expires_in: 3599,
            token_type: "Bearer",
          };
        },
      };
    },
  });

  assert.equal(accessToken, "refreshed-access-token");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GOOGLE_OAUTH_TOKEN_URL);
  const body = new URLSearchParams(calls[0].options.body);
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "refresh-token-abc");
});

test("insertGoogleCalendarEvent auto-refreshes access token then books event", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: "runtime-access-token",
            token_type: "Bearer",
          };
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          id: "event-123",
          htmlLink: "https://calendar.google.com/event?eid=event-123",
        };
      },
    };
  };

  const result = await insertGoogleCalendarEvent({
    config: { calendarId: "strict-calendar-id" },
    booking: {
      summary: "Project Sync",
      start: "2026-03-10T09:00:00+01:00",
      end: "2026-03-10T09:30:00+01:00",
      attendees: ["guest-a@example.com", { email: "guest-b@example.com" }],
    },
    credentials: {
      refreshToken: "refresh-token-xyz",
      clientSecret: { value: CLIENT_SECRET_JSON },
    },
    fetchImpl,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, GOOGLE_OAUTH_TOKEN_URL);
  const insertUrl = new URL(calls[1].url);
  assert.equal(
    `${insertUrl.origin}${insertUrl.pathname}`,
    `${GOOGLE_CALENDAR_API_BASE_URL}/calendars/strict-calendar-id/events`,
  );
  assert.equal(insertUrl.searchParams.get("sendUpdates"), "all");
  assert.equal(insertUrl.searchParams.get("conferenceDataVersion"), "1");
  assert.equal(calls[1].options.headers.Authorization, "Bearer runtime-access-token");
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.start.timeZone, DEFAULT_TIMEZONE);
  assert.equal(body.end.timeZone, DEFAULT_TIMEZONE);
  assert.deepEqual(body.attendees, [
    { email: "guest-a@example.com" },
    { email: "guest-b@example.com" },
  ]);
  assert.equal(body.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
  assert.equal(typeof body.conferenceData.createRequest.requestId, "string");
  assert.ok(body.conferenceData.createRequest.requestId.length > 0);
  assert.equal(result.message, "Booked ✅ https://calendar.google.com/event?eid=event-123");
  assert.deepEqual(result, {
    message: "Booked ✅ https://calendar.google.com/event?eid=event-123",
  });
});

test("insertGoogleCalendarEvent prefers Meet link over htmlLink in success message", async () => {
  let callIndex = 0;
  const result = await insertGoogleCalendarEvent({
    config: {},
    booking: {
      summary: "Meet-first booking",
      start: "2026-03-10T10:00:00+01:00",
      end: "2026-03-10T10:30:00+01:00",
    },
    credentials: {
      refreshToken: "refresh-token-meet-link",
      clientSecret: { value: CLIENT_SECRET_JSON },
    },
    fetchImpl: async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: "meet-link-access-token",
              token_type: "Bearer",
            };
          },
        };
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: "event-456",
            hangoutLink: "https://meet.google.com/abc-defg-hij",
            htmlLink: "https://calendar.google.com/event?eid=event-456",
          };
        },
      };
    },
  });

  assert.equal(result.message, "Booked ✅ https://meet.google.com/abc-defg-hij");
});

test("insertGoogleCalendarEvent uses conferenceData video link when hangoutLink is unavailable", async () => {
  let callIndex = 0;
  const result = await insertGoogleCalendarEvent({
    config: {},
    booking: {
      summary: "Conference entry-point booking",
      start: "2026-03-10T10:00:00+01:00",
      end: "2026-03-10T10:30:00+01:00",
    },
    credentials: {
      refreshToken: "refresh-token-entry-point",
      clientSecret: { value: CLIENT_SECRET_JSON },
    },
    fetchImpl: async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: "entry-point-access-token",
              token_type: "Bearer",
            };
          },
        };
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: "event-789",
            conferenceData: {
              entryPoints: [
                {
                  entryPointType: "video",
                  uri: "https://meet.google.com/xyz-abcd-efg",
                },
              ],
            },
            htmlLink: "https://calendar.google.com/event?eid=event-789",
          };
        },
      };
    },
  });

  assert.equal(result.message, "Booked ✅ https://meet.google.com/xyz-abcd-efg");
});

test("insertGoogleCalendarEvent falls back to primary calendar when config.calendarId is absent", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: "runtime-access-token-2",
          };
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          id: "event-primary",
          htmlLink: "https://calendar.google.com/event?eid=event-primary",
        };
      },
    };
  };

  await insertGoogleCalendarEvent({
    config: {},
    booking: {
      summary: "Default Calendar Check",
      start: "2026-03-10T10:00:00+01:00",
      end: "2026-03-10T10:30:00+01:00",
    },
    credentials: {
      refreshToken: "refresh-token-456",
      clientSecret: { value: CLIENT_SECRET_JSON },
    },
    fetchImpl,
  });

  assert.equal(calls.length, 2);
  const insertUrl = new URL(calls[1].url);
  assert.equal(
    `${insertUrl.origin}${insertUrl.pathname}`,
    `${GOOGLE_CALENDAR_API_BASE_URL}/calendars/primary/events`,
  );
  assert.equal(insertUrl.searchParams.get("sendUpdates"), "all");
  assert.equal(insertUrl.searchParams.get("conferenceDataVersion"), "1");
});

test("insertGoogleCalendarEvent maps missing refresh token to clear booking error", async () => {
  await assert.rejects(
    () =>
      insertGoogleCalendarEvent({
        config: {},
        booking: {
          summary: "Missing token case",
          start: "2026-03-10T11:00:00+01:00",
          end: "2026-03-10T11:30:00+01:00",
        },
        credentials: {
          clientSecret: { value: CLIENT_SECRET_JSON },
        },
      }),
    (error) => {
      assert.equal(error.code, MISSING_REFRESH_TOKEN_ERROR);
      assert.equal(
        toUserFacingBookingError(error),
        "Booking failed: missing Google OAuth refresh token.",
      );
      return true;
    },
  );
});

test("refreshGoogleAccessToken maps OAuth failure to user-facing refresh error", async () => {
  await assert.rejects(
    () =>
      refreshGoogleAccessToken({
        credentials: {
          refreshToken: "bad-refresh-token",
          clientSecret: { value: CLIENT_SECRET_JSON },
        },
        fetchImpl: async () => ({
          ok: false,
          status: 400,
          async json() {
            return {
              error: "invalid_grant",
              error_description: "Bad Request",
            };
          },
        }),
      }),
    (error) => {
      assert.equal(error.code, ACCESS_TOKEN_REFRESH_FAILED_ERROR);
      assert.equal(
        toUserFacingBookingError(error),
        "Booking failed: could not refresh Google OAuth access token.",
      );
      return true;
    },
  );
});

test("toUserFacingBookingError maps invalid insert response to clear link error", () => {
  assert.equal(
    toUserFacingBookingError({ code: "GOOGLE_CALENDAR_INVALID_INSERT_RESPONSE" }),
    "Booking failed: Google Calendar returned event without a usable booking link.",
  );
});

test("writeSecretRefValueFile stores SecretRef-compatible token file", async () => {
  const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-booking-bot-"));
  const targetFile = path.join(targetDir, "google-oauth-refresh-token.json");

  await writeSecretRefValueFile({
    filePath: targetFile,
    value: "refresh-secret",
  });

  const content = await fs.readFile(targetFile, "utf8");
  assert.deepEqual(JSON.parse(content), { value: "refresh-secret" });
});

test("createCalendarEvent delegates to events.insert helper", async () => {
  let callIndex = 0;
  const result = await createCalendarEvent({
    config: {},
    booking: {
      summary: "Wrapper check",
      start: "2026-03-10T12:00:00+01:00",
      end: "2026-03-10T12:30:00+01:00",
    },
    credentials: {
      refreshToken: "refresh-token-wrapper",
      clientSecret: { value: CLIENT_SECRET_JSON },
    },
    fetchImpl: async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: "wrapper-access-token",
              token_type: "Bearer",
            };
          },
        };
      }

      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: "event-wrapper",
            htmlLink: "https://calendar.google.com/event?eid=event-wrapper",
          };
        },
      };
    },
  });

  assert.equal(
    result.message,
    "Booked ✅ https://calendar.google.com/event?eid=event-wrapper",
  );
});
