/**
 * Polling interval management functionality.
 * Handles the timing and execution of polling operations.
 */

const { fromMinutes } = require('../../datetime/duration');

const POLL_INTERVAL = fromMinutes(10);
const THREAD_NAME = "volodyslav:scheduler:poll"

/**
 * Create an interval manager for handling polling timing.
 * @param {() => Promise<void>} pollFunction - Function to call on each poll
 * @param {import('../types').SchedulerCapabilities} capabilities - For error logging
 * @returns {{start: () => void, stop: () => Promise<void>}} Interval manager with start/stop methods
 */
function makeIntervalManager(pollFunction, capabilities) {
    async function wrappedPoll() {
        try {
            await pollFunction();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            capabilities.logger.logError({ errorMessage: message }, `Unexpected poll error: ${message}`);
        }
    }

    const thread = capabilities.threading.periodic(THREAD_NAME, POLL_INTERVAL, wrappedPoll);
    const start = () => thread.start();
    const stop = async () => await thread.stop();

    return { start, stop };
}

module.exports = {
    makeIntervalManager,
    POLL_INTERVAL,
    THREAD_NAME,
};
