/**
 * Individual generators module.
 * Provides generators that compute individual derived data.
 */

const metaEvents = require('./meta_events');
const eventContext = require('./event_context');
const event = require('./event');
const calories = require('./calories');
const associatedAudio = require('./associated_audio');
const transcription = require('./transcription');

module.exports = {
    metaEvents,
    eventContext,
    event,
    calories,
    associatedAudio,
    transcription,
};
