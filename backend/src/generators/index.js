/**
 * Generators module.
 * Provides the incremental graph interface for event-driven computation.
 */

const { makeInterface, isInterface } = require('./interface');
const { event: individualEvent } = require('./individual');
const { synchronizeDatabase } = require('./incremental_graph');

/** @typedef {import('./interface').Interface} Interface */

module.exports = {
    makeInterface,
    isInterface,
    isEventNotFoundError: individualEvent.isEventNotFoundError,
    synchronizeDatabase,
};
