/**
 * Generators module.
 * Provides the incremental graph interface for event-driven computation.
 */

const { makeInterface, isInterface } = require('./interface');
const { event: individualEvent } = require('./individual');

/** @typedef {import('./interface').Interface} Interface */

module.exports = {
    makeInterface,
    isInterface,
    isEventNotFoundError: individualEvent.isEventNotFoundError,
};
