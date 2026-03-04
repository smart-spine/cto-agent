#!/usr/bin/env node

const bookingHelper = require("./book-google-calendar-event.js");

async function createCalendarEvent(input = {}) {
  return bookingHelper.insertGoogleCalendarEvent(input);
}

module.exports = {
  ...bookingHelper,
  createCalendarEvent,
};
