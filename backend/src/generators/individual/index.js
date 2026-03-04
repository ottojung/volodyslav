/**
 * Individual generators module.
 * Provides generators that compute individual derived data.
 */

const metaEvents = require('./meta_events');
const eventContext = require('./event_context');
const event = require('./event');
const calories = require('./calories');

module.exports = {
    metaEvents,
    eventContext,
    event,
    calories,
};
