/**
 * Lifecycle module.
 * Encapsulates all functionality related to polling lifecycle management.
 */

const { makeIntervalManager, POLL_INTERVAL_MS } = require('./interval');
const { makePollingFunction } = require('./polling');

module.exports = {
    makeIntervalManager,
    makePollingFunction,
    POLL_INTERVAL_MS,
};