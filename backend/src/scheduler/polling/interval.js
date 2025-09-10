/**
 * Polling interval management functionality.
 * Handles the timing and execution of polling operations.
 */

const { fromMinutes } = require('../../datetime');

const POLL_INTERVAL = fromMinutes(10);
const THREAD_NAME = "volodyslav:scheduler:poll";

module.exports = {
    POLL_INTERVAL,
    THREAD_NAME,
};
