/**
 * Individual generators module.
 * Provides generators that compute individual derived data.
 */

const config = require('./config');
const allEvents = require('./all_events');
const sortedEventsDescending = require('./sorted_events_descending');
const sortedEventsAscending = require('./sorted_events_ascending');
const lastEntries = require('./last_entries');
const firstEntries = require('./first_entries');
const eventsCount = require('./events_count');
const metaEvents = require('./meta_events');
const eventContext = require('./event_context');
const event = require('./event');
const calories = require('./calories');
const transcription = require('./transcription');
const eventTranscription = require('./event_transcription');

module.exports = {
    config,
    allEvents,
    sortedEventsDescending,
    sortedEventsAscending,
    lastEntries,
    firstEntries,
    eventsCount,
    metaEvents,
    eventContext,
    event,
    calories,
    transcription,
    eventTranscription,
};
