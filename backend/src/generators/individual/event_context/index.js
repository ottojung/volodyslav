/**
 * Event context generator module.
 * Computes the event_context representation.
 */

const { computeEventContexts, reconstructEventsFromMetaEvents } = require('./compute');
const { computor } = require('./wrapper');

/** @typedef {import('./compute').EventContextEntry} EventContextEntry */

module.exports = {
    computeEventContexts,
    reconstructEventsFromMetaEvents,
    computor,
};
