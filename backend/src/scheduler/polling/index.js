/**
 * Lifecycle module.
 * Encapsulates all functionality related to polling lifecycle management.
 */

const { POLL_INTERVAL_MS } = require('./interval');
const { makePollingScheduler } = require('./make');

module.exports = {
    POLL_INTERVAL_MS,
    makePollingScheduler,
};
