#!/usr/bin/env node

const DEFAULT_TIMEZONE = "Europe/Warsaw";
const DEFAULT_CALENDAR_ID = "primary";
const CALENDAR_SELECTION_RULE =
  "if config.calendarId is set use it strictly, else use primary";

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function ensureObject(value, fieldName) {
  if (value == null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return value;
}

function ensureNonEmptyString(value, fieldName) {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return trimmed;
}

function parseDateTime(value, fieldName) {
  const raw = ensureNonEmptyString(value, fieldName);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new Error(`${fieldName} must be a valid ISO datetime`);
  }
  return { raw, ms };
}

function normalizeAttendees(attendees) {
  if (attendees == null) {
    return [];
  }
  if (!Array.isArray(attendees)) {
    throw new Error("booking.attendees must be an array when provided");
  }

  return attendees.map((entry, index) => {
    if (typeof entry === "string") {
      return { email: ensureNonEmptyString(entry, `booking.attendees[${index}]`) };
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return {
        email: ensureNonEmptyString(
          entry.email,
          `booking.attendees[${index}].email`,
        ),
      };
    }
    throw new Error(
      `booking.attendees[${index}] must be a string email or object with email`,
    );
  });
}

function resolveCalendarTarget(config = {}) {
  const cfg = ensureObject(config, "config");
  if (hasOwn(cfg, "calendarId")) {
    return ensureNonEmptyString(cfg.calendarId, "config.calendarId");
  }
  return DEFAULT_CALENDAR_ID;
}

function resolveTimezone(config = {}, booking = {}) {
  const cfg = ensureObject(config, "config");
  const request = ensureObject(booking, "booking");
  const candidate = hasOwn(request, "timezone")
    ? request.timezone
    : cfg.timezone;
  if (candidate == null) {
    return DEFAULT_TIMEZONE;
  }
  const fieldName = hasOwn(request, "timezone")
    ? "booking.timezone"
    : "config.timezone";
  return ensureNonEmptyString(candidate, fieldName);
}

function readOptionalString(value, fieldName) {
  if (value == null) {
    return undefined;
  }
  return ensureNonEmptyString(value, fieldName);
}

function prepareBookingPayload(input = {}) {
  const params = ensureObject(input, "input");
  const config = ensureObject(params.config, "input.config");
  const booking = ensureObject(params.booking, "input.booking");

  const start = parseDateTime(booking.start, "booking.start");
  const end = parseDateTime(booking.end, "booking.end");
  if (end.ms <= start.ms) {
    throw new Error("booking.end must be after booking.start");
  }

  const timezone = resolveTimezone(config, booking);
  const event = {
    summary: ensureNonEmptyString(booking.summary, "booking.summary"),
    start: {
      dateTime: start.raw,
      timeZone: timezone,
    },
    end: {
      dateTime: end.raw,
      timeZone: timezone,
    },
    attendees: normalizeAttendees(booking.attendees),
  };

  const description = readOptionalString(booking.description, "booking.description");
  if (description !== undefined) {
    event.description = description;
  }

  const location = readOptionalString(booking.location, "booking.location");
  if (location !== undefined) {
    event.location = location;
  }

  return {
    backend: "google-calendar",
    calendarId: resolveCalendarTarget(config),
    selectionRule: CALENDAR_SELECTION_RULE,
    timezone,
    event,
  };
}

module.exports = {
  CALENDAR_SELECTION_RULE,
  DEFAULT_CALENDAR_ID,
  DEFAULT_TIMEZONE,
  normalizeAttendees,
  prepareBookingPayload,
  resolveCalendarTarget,
  resolveTimezone,
};
