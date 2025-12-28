/**
 * Event context generator module.
 * Computes the event_context representation.
 */

const { computeEventContexts, computeEventContextsIncremental, reconstructEventsFromMetaEvents } = require('./compute');

/** @typedef {import('./compute').EventContextEntry} EventContextEntry */
/** @typedef {import('./compute').IncrementalState} IncrementalState */

module.exports = {
    computeEventContexts,
    computeEventContextsIncremental,
    reconstructEventsFromMetaEvents,
};
